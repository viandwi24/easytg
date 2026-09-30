import type { Bot, Context, MiddlewareFn, MiddlewareObj, Transformer } from 'grammy';
import { createThrottle, type ThrottleOptions } from './throttle';
import type { InlineQueryResult, Message, PreCheckoutQuery, ReplyKeyboardMarkup, ReplyKeyboardRemove, SuccessfulPayment } from 'grammy/types';
import {
  BACK_ID,
  DIALOGUE_BUTTON_ID,
  EXIT_ID,
  assertFits,
  decodeInline,
  decodeStoredToken,
  encodeInline,
  fitsCallback,
  normalizeParams,
  type ParamsInput,
} from './callback';
import { SpamGuard, type AntiSpamOptions, type SpamEvent } from './antispam';
import { Locks, Queue, assertAtomic, type AtomicStorage, type QueueOptions, type Release } from './coordination';
import { runBroadcast, type BroadcastResult, type BroadcastSettings } from './broadcast';
import { CallbackStore, type CallbackParamsMode, type StoredCallback } from './callback-store';
import type { Dialogue, Page, Task, TaskBot } from './define';
import { DialogueRunner, isCommand, parseWebAppData } from './dialogue';
import { Commands, type CommandOptions } from './commands';
import { RelayStore, relayBotId, type RelayBot, type RelayEndReason, type RelayLink, type RelayStartOptions } from './relay';
import { EasyTGError, InvalidParamsError, isChatUnreachable, isMessageNotFound, isTransient } from './errors';
import { Scheduler, type ScheduleOptions, type SchedulerOptions, type TaskErrorEvent } from './scheduler';
import type { ParseMode, TextInput } from './format';
import { createConsoleLogger, silentLogger, type Logger } from './logger';
import type { ReplyMenu } from './menu';
import { Nav } from './nav';
import { decodeDeepLink, deepLinkUrl, encodeDeepLinkInline, encodeDeepLinkStored, startPayload } from './deeplink';
import { allowedUsersOf, createProactiveContext, isProactive, threadIdOf, type SendTarget } from './proactive';
import { sign, verify } from './sign';
import {
  deliver,
  prepareContent,
  sentBeforeError,
  pressedMessage,
  removeWithGroup,
  type Delivery,
  type DeliveryResult,
  type EditTarget,
  type PreparedContent,
  type SentMessage,
} from './render';
import { Session } from './session';
import { MemoryStorage, isTaskStore, withPrefix, type StorageAdapter } from './storage';
import { sha256, toBase64Url } from './platform/crypto';
import { AsyncContext } from './platform/context';
import { defaultTexts, type EasyTGTexts } from './texts';
import { Translator, normalizeLocale, type Messages, type Translate } from './i18n';
import {
  DialogueStart,
  Redirect,
  type ButtonOptions,
  type DeliveryMode,
  type DialogueCancelReason,
  type LoadingOptions,
  type Middleware,
  type MiddlewareArgs,
  type PageContent,
  type Params,
  type ParamArgs,
  type ParamsArgs,
  type ParamsInputOf,
  type RenderArgs,
  type RenderResult,
  type Awaitable,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER_TTL_MS = 7 * DAY_MS;
const CALLBACK_TTL_MS = 30 * DAY_MS;
const DEEP_LINK_TTL_MS = 365 * DAY_MS;
const MAX_REDIRECTS = 5;
/** Session key of the per-message navigation history behind `nav.back()`. */
const NAV_KEY = '_easytg:nav';
const MAX_BACK_STEPS = 10;
const MAX_NAV_MESSAGES = 20;

interface View {
  id: string;
  params: Record<string, string>;
}

/** Session keys of the language chosen with `setLocale`, and of the Telegram app's language last seen. */
const LOCALE_KEY = '_easytg:locale';
const LAST_LANGUAGE_KEY = '_easytg:lang';

/** Session key of the message ids with a pending `deleteAfterMs`. */
const AUTODELETE_KEY = '_easytg:autodelete';

/** Session key of the page that receives the user's text (`page.onText`). */
const INPUT_KEY = '_easytg:input';

interface TextInputState extends View {
  messageId: number;
}

/** Per menu message: the page it shows and the pages before it. */
type NavHistory = Record<string, { current: View; stack: View[]; /** last used (ms) */ at?: number }>;

export interface EasyTGOptions<C extends Context = Context> {
  /** Default adapter for everything easytg persists. Default: in-memory (development only). */
  storage?: StorageAdapter;
  /** Prefix for every key easytg writes, e.g. `'mybot:'` when several bots share a database. */
  keyPrefix?: string;
  /** How plain-string text is parsed. Default `markdown`. */
  parseMode?: ParseMode;
  /** Id of the page `nav.home()` opens. Default `home`. */
  homePage?: string;
  /** Middlewares for every page render and dialogue start, outermost first. */
  middlewares?: Middleware<C>[];
  /** Custom logger, or `false` to silence easytg. Default: warnings and errors to the console. */
  logger?: Logger | false;
  /** Relays between users (`app.relay`): checks for relayed messages. */
  relay?: RelayOptions<C>;
  /** Main menu on the reply keyboard; show it with `app.showMenu(ctx, text)`. See `replyMenu`. */
  menu?: ReplyMenu<C>;
  /** Protect all sent messages from forwarding and saving (`protect_content`). Pages can override it. Default false. */
  protectContent?: boolean;
  /**
   * Include the bot id in storage keys (sessions, buttons, message metadata),
   * so several bots can share one storage. Deep links are never bot-specific.
   * Default true; `false` keeps the 0.1 key format.
   */
  scopeKeysByBot?: boolean;
  /**
   * Called for contexts easytg creates itself (`sendTo`, `edit`, `broadcast`)
   * before rendering, to add what your middlewares normally put on `ctx`.
   */
  prepareProactive?: (ctx: C) => Awaitable<void>;
  session?: SessionOptions;
  buttons?: ButtonsOptions;
  deepLinks?: DeepLinksOptions;
  media?: MediaOptions;
  dialogues?: DialoguesOptions;
  /**
   * Also emit errors of `sendTo` and `edit` as `error` events (they are still
   * thrown to the caller). `broadcast` reports failures in its result instead.
   * Default false.
   */
  emitProactiveErrors?: boolean;
  /** Rate limit per user. Default on (20 updates / 10 s); `false` disables. */
  antiSpam?: AntiSpamOptions<C> | false;
  /**
   * Handle one update per user and chat at a time, in order, so concurrent
   * updates (webhooks, grammY runner) can't race on the same session. A button
   * pressed while the user's previous update is still running gets the `busy`
   * toast; other updates wait up to `timeoutMs` (default 8 000, below grammY's
   * 10 s webhook timeout), then run anyway. Default true.
   */
  sequential?: boolean | { timeoutMs?: number };
  /**
   * Share rate limits, locks, double-tap state and queues between processes
   * (several instances of the bot). `true` uses `storage`; or pass another
   * adapter. It must support `increment` and `setIfAbsent` (`RedisStorage`,
   * `SqliteStorage`). Default false: per process.
   */
  cluster?: boolean | StorageAdapter;
  /** Loading indicators for every page (pages can set their own with `.loading(...)`). Default: none. */
  loading?: LoadingOptions;
  /** Concurrency limits for `app.queue` / `app.enterQueue`, by name: `{ ai: { concurrency: 5 } }`. */
  queues?: Record<string, QueueOptions>;
  /** Scheduled tasks (`app.schedule`, `deleteLater`, `sendLater`); run them with `app.startScheduler(bot)`. */
  scheduler?: SchedulerOptions;
  /** Handle checkout and successful payments of `invoice` content. Without it, both go to your own handlers. */
  payments?: PaymentsOptions<C>;
  i18n?: I18nOptions<C>;
}

export interface PaymentsOptions<C extends Context = Context> {
  /**
   * Check an order before the user is charged (answered within Telegram's 10
   * seconds): return true to accept, or a message for the user to refuse.
   * Default: accept.
   */
  preCheckout?: (args: { ctx: C; query: PreCheckoutQuery; payload: string }) => Awaitable<true | string>;
  /**
   * After a successful payment: deliver the goods and return what to show
   * (like a render). The `payment` event fires too. Without it, the payment
   * message goes to your own handlers.
   */
  onSuccess?: (args: PaymentArgs<C>) => Awaitable<RenderResult>;
}

export interface PaymentArgs<C extends Context = Context> {
  ctx: C;
  payment: SuccessfulPayment;
  /** The invoice's `payload`. */
  payload: string;
  session: Session;
  locale: string | undefined;
  t: Translate;
  nav: Nav<C>;
  app: EasyTG<C>;
}

export interface SessionOptions {
  /** Where sessions (incl. dialogue state) live. Default: `storage`. */
  storage?: StorageAdapter;
  /**
   * The version of your session data. When it changes, `migrate` converts
   * each stored session (user and chat sessions too) the next time it is loaded.
   */
  version?: number;
  /** Convert data stored under an older `version` (0 = before versions were used). */
  migrate?: (data: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
  /** Delete a session this many ms after the user was last active. Default: never. */
  ttlMs?: number;
  /**
   * Any interaction keeps the session alive, not only changes. Default true.
   * To save writes, the expiry is refreshed once half of the TTL has passed.
   */
  refreshOnActivity?: boolean;
}

export interface MediaOptions {
  /**
   * Remember the `file_id` Telegram gives a photo, video, … sent by URL, and
   * send that next time instead of the URL (faster, no re-download by
   * Telegram). Kept in `buttons.storage`, per bot. Default false.
   */
  cacheFileIds?: boolean;
  /** How long a remembered file id is used. Default 30 days. */
  cacheTtlMs?: number;
}

export interface ButtonsOptions {
  /** Where stored button params, deep-link params and message metadata live. Default: `storage`. */
  storage?: StorageAdapter;
  /** Where button params live: `inline`, `auto` (default), `stored` or `signed`. See `CallbackParamsMode`. */
  params?: CallbackParamsMode;
  /** Secret for `params: 'signed'` (at least 16 characters). Keep it private and stable. */
  secret?: string;
  /**
   * When a button under a media message opens a page without media: `replace`
   * (default) deletes the media message, `keep` leaves it and sends the page as
   * a new message (only the buttons are removed from the media message).
   * Per button, `{ mode: 'send' }` leaves the pressed message completely untouched.
   */
  mediaToText?: 'replace' | 'keep';
  /** How long stored button params stay valid. Default 30 days. */
  ttlMs?: number;
  /**
   * Ignore a repeated press of the same button within this many ms after the
   * previous one finished (accidental double taps). Default 700, 0 disables.
   */
  doubleTapMs?: number;
  /** In groups, only the user a menu was sent to can press its buttons. Default true. */
  ownerOnly?: boolean;
}

export interface DeepLinksOptions {
  /** How long stored deep-link params stay valid. Default 365 days. */
  ttlMs?: number;
}

export interface DialoguesOptions {
  /** A /command sent during a dialogue cancels it (and the command still runs). Default true. */
  cancelOnCommand?: boolean;
  /** End dialogues after this many ms without an answer (see `dialogue.timeout`). Default: never. */
  timeoutMs?: number;
}

export interface I18nOptions<C extends Context = Context> {
  /** Override built-in (English) labels and messages. */
  texts?: Partial<EasyTGTexts>;
  /** Built-in texts per language, merged over `texts`: `{ id: { cancel: '❌ Batal', … } }`. */
  locales?: Record<string, Partial<EasyTGTexts>>;
  /** The user's language. Default: `ctx.from.language_code`; `pt-br` falls back to `pt`. */
  locale?: (ctx: C, session: Session) => string | undefined;
  /**
   * Your app's messages per language, for `t` in renders, dialogues and
   * middlewares (and `app.t(ctx)`): `{ en: { hello: 'Hi {name}!' }, id: { … } }`.
   * A message can have plural forms: `{ one: '{count} item', other: '{count} items' }`.
   */
  messages?: Record<string, Messages>;
  /** Language used for users whose language (or a missing key) isn't in `messages`. Default `en`. */
  fallbackLocale?: string;
}

/** Events emitted by `app.on(...)`. */
export interface EasyTGEvents<C extends Context = Context> {
  /** A user exceeded the anti-spam limit and is ignored until `until`. */
  spam: SpamEvent<C>;
  /**
   * An error was caught while handling a button press, dialogue input, menu
   * button or deep link (`source: 'update'`), or in `sendTo` / `edit` with
   * `emitProactiveErrors`.
   */
  error: { error: unknown; ctx: C; source: 'update' | 'sendTo' | 'edit' };
  /** New messages were sent (all of them, for text split across several messages). */
  sent: { ctx: C; chatId: number; messageIds: number[]; page?: string };
  /** A page was shown: `send` as a new message, `edit` in place. */
  pageView: { ctx: C; page: string; params: Params; mode: 'send' | 'edit'; chatId?: number; userId?: number; /** Render and delivery time. */ durationMs: number };
  dialogueStart: { ctx: C; dialogue: string; params: Record<string, unknown> };
  dialogueFinish: { ctx: C; dialogue: string; params: Record<string, unknown>; answers: Record<string, unknown> };
  /** A dialogue ended without finishing; see `DialogueCancelReason`. */
  dialogueCancel: { ctx: C; dialogue: string; params: Record<string, unknown>; answers: Record<string, unknown>; reason: DialogueCancelReason };
  /**
   * A job has to wait for a queue slot. `position` is 1 for the next in line;
   * undefined with `cluster` (not known across processes).
   */
  queueWait: { ctx?: C; queue: string; position?: number };
  /** A scheduled task failed. */
  taskError: TaskErrorEvent;
  /**
   * A Mini App opened from a `replyMenu.webApp` button sent data
   * (`Telegram.WebApp.sendData`). `data` is parsed JSON when it is JSON.
   * It comes from the client: check it. The update then goes on to your handlers.
   */
  webAppData: { ctx: C; data: unknown; raw: string; button: string };
  /** A batch of `broadcastLater` was sent (`batch` counts from 0). */
  broadcastBatch: { broadcast: string; batch: number; batches: number; result: BroadcastResult };
  /**
   * An update went through `bot.use(app)`: `outcome` is `easytg` (handled by
   * a page, dialogue, menu…), `next` (passed on to your handlers; the time
   * includes them), `limited` (dropped: rate limit) or `busy` (dropped: a
   * button pressed while the user's previous update was running) or `error`
   * (an error was thrown to grammY).
   */
  update: { ctx: C; durationMs: number; outcome: UpdateOutcome };
  /** A payment succeeded (only with the `payments` option). Keep `payment.telegram_payment_charge_id` for refunds. */
  payment: { ctx: C; payment: SuccessfulPayment; payload: string };
  /** A message was copied to the other user of a relay. */
  relayMessage: { ctx: C; from: number; to: number; messageId: number };
  /**
   * A relay ended: `app` (`app.relay.end`, or one of its users started
   * another) or `unreachable` (the other user blocked the bot or is gone;
   * `ctx` is the update of the user whose message couldn't be delivered:
   * tell them).
   */
  relayEnd: { botId: number; users: [number, number]; reason: RelayEndReason; ctx?: C };
}

/** Relays between two users' private chats with the bot. */
export interface RelayApi {
  /** Connect two users: from now on what one sends the bot is copied to the other. Ends their earlier relays. */
  start(bot: RelayBot, userA: number, userB: number, options?: RelayStartOptions): Promise<void>;
  /** End the user's relay, for both sides. Returns the link that ended. */
  end(bot: RelayBot, userId: number): Promise<RelayLink | undefined>;
  /** Who the user is connected to, if anyone. */
  peer(bot: RelayBot, userId: number): Promise<RelayLink | undefined>;
}

export interface RelayOptions<C extends Context = Context> {
  /**
   * Check a message before it is copied: `false` drops it, a string drops it
   * and tells the sender why (e.g. no links), anything else lets it through.
   */
  filter?: (args: { ctx: C; peer: number }) => Awaitable<boolean | string | void>;
}

/** When to delete (`delayMs` / `at`) and, optionally, your own task id. */
export type DeleteLaterOptions = Pick<ScheduleOptions, 'delayMs' | 'at' | 'id'>;

/** `ScheduleOptions` plus the page's params. */
export type SendLaterOptions<P> = ScheduleOptions & ({} extends P ? { params?: ParamsInputOf<P> } : { params: ParamsInputOf<P> });

/** What `app.withUser` gives your function. */
export interface WithUserArgs<C extends Context = Context> {
  /** A context without an update (see `isProactive`), for `app.open` & co. */
  ctx: C;
  /** The user's session in their private chat with the bot (or in the given `chatId`). */
  session: Session;
  /** The user's session across all chats. */
  userSession: Session;
  locale: string | undefined;
  t: Translate;
  nav: Nav<C>;
  app: EasyTG<C>;
}

export type InlineResultOptions<P> = {
  /** Shown in the list of results. */
  title: string;
  description?: string;
  thumbnailUrl?: string;
  /** Unique per result, at most 64 bytes. Default: derived from the page and params. */
  id?: string;
} & ({} extends P ? { params?: ParamsInputOf<P> } : { params: ParamsInputOf<P> });

export type UpdateOutcome = 'easytg' | 'next' | 'limited' | 'busy' | 'error';

export type BroadcastOptions<P> = BroadcastSettings & ({} extends P ? { params?: ParamsInputOf<P> } : { params: ParamsInputOf<P> });

export interface OpenOptions {
  /** How the page reaches the chat. Default `auto`: edit on button presses, reply otherwise. */
  mode?: DeliveryMode;
}

type Registrable<C extends Context> = Page<any, C, any> | Dialogue<any, any, C> | Task<any, C>;

type ScheduleArgs<P> = undefined extends P ? [payload?: P, options?: ScheduleOptions] : [payload: P, options?: ScheduleOptions];

/** Built-in tasks behind `deleteLater` / `sendLater` / `deleteAfterMs`. */
const DELETE_TASK = '_easytg:delete';
const SEND_TASK = '_easytg:send';
const BROADCAST_TASK = '_easytg:broadcast';
const REFRESH_TASK = '_easytg:refresh';

interface RefreshPayload {
  chatId: number;
  messageId: number;
  userId?: number;
  threadId?: number;
  allowedUsers?: number[];
  page: string;
  params: Record<string, string>;
}

interface BroadcastBatchPayload {
  broadcast: string;
  batch: number;
  batches: number;
  targets: Array<number | SendTarget>;
  page: string;
  params: Record<string, string>;
  perSecond: number;
  concurrency?: number;
}

export type BroadcastLaterOptions<P> = Omit<BroadcastSettings, 'onProgress' | 'signal'> &
  Pick<ScheduleOptions, 'delayMs' | 'at' | 'botId'> & {
    /** Recipients per scheduled task. Default 100. */
    batchSize?: number;
  } & ({} extends P ? { params?: ParamsInputOf<P> } : { params: ParamsInputOf<P> });

/** Per-update state: loaded session, stored buttons waiting to be written, answered flag. */
interface UpdateScope {
  session?: Promise<Session>;
  /** Resolved language; undefined until the session is loaded. */
  locale?: string | null;
  pending: Map<string, StoredCallback>;
  pendingLinks: Map<string, StoredCallback>;
  answered: boolean;
  /** Back stack for the page being rendered. */
  navStack?: View[];
  /** The page actually rendered (after redirects). */
  view?: View;
  botScope?: string;
  /** `app.edit`: the message to edit, and don't send when it can't be edited. */
  editTarget?: EditTarget;
  noFallback?: boolean;
  /** Handled by the middleware (not a context created by `sendTo` etc.). */
  inUpdate?: boolean;
  /** Queue slots taken with `enterQueue`, released when the update ends. */
  held?: Release[];
  /** Proactive context of a user whose update is being handled: use that update's session. */
  sharedWith?: Context;
  /** `allowedUsers` of the pressed menu, kept for what the press renders. */
  allowedUsers?: number[];
  /** `app.t(ctx)`, created once. */
  t?: Translate;
  userSession?: Promise<Session>;
  /** Loaded sessions, for synchronous access. */
  stateValue?: Session;
  userValue?: Session;
  /** `refreshEveryMs` of the page content just delivered. */
  refreshEveryMs?: number;
  /** A `refreshEveryMs` re-render: a pending `deleteAfterMs` keeps its deadline. */
  refreshing?: boolean;
  /** Redirects and dialogue starts in this update, against loops. */
  redirects?: number;
  /** Rendering a message that ends up in someone else's chat (Mini App results): buttons aren't bound to a user. */
  inlineRender?: boolean;
  /** A loading placeholder sent while rendering, for the page to replace. */
  placeholder?: { chatId: number; messageId: number };
  chatSession?: Promise<Session>;
}

type OpenArgs<P> = {} extends P
  ? [params?: ParamsInputOf<P>, options?: OpenOptions]
  : [params: ParamsInputOf<P>, options?: OpenOptions];


type BotLike = Pick<Bot<any>, 'api' | 'botInfo' | 'isInited' | 'init'>;

/** The message `app.edit` updates. */
export type EditMessageTarget = SendTarget & { messageId: number };

export class EasyTG<C extends Context = Context> implements MiddlewareObj<C> {
  /** @internal */ readonly texts: EasyTGTexts;
  /** @internal */ readonly logger: Logger;
  /** @internal */ readonly homePage: string;
  /** @internal */ readonly cancelDialogueOnCommand: boolean;
  /** @internal */ readonly dialogueTimeoutMs?: number;

  private readonly parseMode: ParseMode;
  private readonly callbackParams: CallbackParamsMode;
  private readonly pages = new Map<string, Page<any, C, any>>();
  private readonly dialogueDefs = new Map<string, Dialogue<any, any, C>>();
  private readonly scopes = new WeakMap<Context, UpdateScope>();
  private readonly dialogues = new DialogueRunner<C>(this);
  private readonly middlewares: Middleware<C>[];
  private readonly sessionStorage: StorageAdapter;
  private readonly metaStorage: StorageAdapter;
  private readonly callbacks: CallbackStore;
  private readonly deepLinks: CallbackStore;
  private readonly locales: Record<string, Partial<EasyTGTexts>>;
  private readonly localeTexts = new Map<string, EasyTGTexts>();
  private readonly localeFn?: (ctx: C, session: Session) => string | undefined;
  private readonly translator: Translator;
  private readonly scheduler: Scheduler;
  private readonly payments?: PaymentsOptions<C>;
  private readonly defaultLoading?: LoadingOptions;
  private readonly doubleTapMs: number;
  /** Rate limits, double taps and locks: in memory, or shared with `cluster`. */
  private readonly coordination: AtomicStorage;
  private readonly locks: Locks;
  private readonly queues = new Map<string, Queue>();
  /** Updates being handled in this process, by `userKey`. */
  private readonly liveUpdates = new Map<string, C>();
  private readonly sequentialTimeoutMs?: number;
  private readonly sessionTtlMs?: number;
  private readonly refreshSessions: boolean;
  private readonly cacheFileIds: boolean;
  private readonly fileIdTtlMs: number;
  private readonly sessionVersion?: number;
  private readonly migrateSession?: (data: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
  private readonly spamGuard: SpamGuard;
  private readonly antiSpam: AntiSpamOptions<C> | undefined;
  private readonly listeners = new Map<keyof EasyTGEvents<C>, Set<(event: any) => unknown>>();
  private readonly ownerOnly: boolean;
  private readonly menu?: ReplyMenu<C>;
  private readonly commands = new Commands<Page<any, any, any> | Dialogue<any, any, any>>();
  private readonly localeNames: string[];
  private readonly relays: RelayStore;
  private readonly relayFilter?: RelayOptions<C>['filter'];
  private readonly fallbackLocale: string;
  /** @internal */ readonly mediaToText: 'replace' | 'keep';
  private readonly protectContent: boolean;
  private readonly scopeKeysByBot: boolean;
  private readonly secret?: string;
  private readonly prepareProactive?: (ctx: C) => Awaitable<void>;
  private readonly emitProactiveErrors: boolean;

  constructor(options: EasyTGOptions<C> = {}) {
    const storage = options.storage ?? new MemoryStorage();
    const scoped = (adapter?: StorageAdapter) => withPrefix(adapter ?? storage, options.keyPrefix ?? '');
    const { session = {}, buttons = {}, deepLinks = {}, dialogues = {}, i18n = {}, media = {} } = options;
    this.cacheFileIds = media.cacheFileIds ?? false;
    this.fileIdTtlMs = media.cacheTtlMs ?? 30 * DAY_MS;

    this.sessionStorage = scoped(session.storage);
    this.sessionTtlMs = session.ttlMs;
    this.refreshSessions = session.refreshOnActivity ?? true;
    this.sessionVersion = session.version;
    this.migrateSession = session.migrate;
    if (session.migrate && session.version === undefined) throw new EasyTGError('session.migrate needs session.version');

    this.metaStorage = scoped(buttons.storage);
    this.callbacks = new CallbackStore(this.metaStorage, buttons.ttlMs ?? CALLBACK_TTL_MS);
    this.deepLinks = new CallbackStore(this.metaStorage, deepLinks.ttlMs ?? DEEP_LINK_TTL_MS, 'dl:');
    this.callbackParams = buttons.params ?? 'auto';
    this.mediaToText = buttons.mediaToText ?? 'replace';
    this.secret = buttons.secret;
    if (this.callbackParams === 'signed' && (!this.secret || this.secret.length < 16)) {
      throw new EasyTGError("buttons.params 'signed' needs buttons.secret with at least 16 characters");
    }
    this.doubleTapMs = buttons.doubleTapMs ?? 700;
    this.ownerOnly = buttons.ownerOnly ?? true;

    this.cancelDialogueOnCommand = dialogues.cancelOnCommand ?? true;
    this.dialogueTimeoutMs = dialogues.timeoutMs;

    const shared = options.cluster === true ? storage : options.cluster || undefined;
    if (shared) assertAtomic(shared, 'cluster');
    const sharedScoped = shared && (scoped(shared) as AtomicStorage);
    this.coordination = sharedScoped ?? new MemoryStorage();
    this.locks = new Locks(sharedScoped);
    for (const [name, queue] of Object.entries(options.queues ?? {})) this.queues.set(name, new Queue(name, queue, sharedScoped));
    const sequential = options.sequential ?? true;
    if (sequential) this.sequentialTimeoutMs = (sequential === true ? undefined : sequential.timeoutMs) ?? 8_000;

    this.scheduler = new Scheduler(
      options.scheduler?.store ?? (isTaskStore(storage) ? storage : undefined),
      options.logger === false ? silentLogger : options.logger ?? createConsoleLogger(),
      async (event) => {
        if ((await this.emit('taskError', event)) === 0) this.logger.error(`Scheduled task "${event.task.name}" failed`, event.error);
      },
      options.scheduler ?? {},
    );
    this.defineBuiltinTasks();
    this.payments = options.payments;
    this.defaultLoading = options.loading;

    const antiSpam = options.antiSpam === false ? undefined : options.antiSpam ?? {};
    this.antiSpam = antiSpam && { warn: true, ...antiSpam };
    this.spamGuard = new SpamGuard(
      this.coordination,
      antiSpam?.limit ?? 20,
      antiSpam?.windowMs ?? 10_000,
      antiSpam?.cooldownMs ?? 30_000,
    );

    this.texts = { ...defaultTexts, ...i18n.texts };
    this.translator = new Translator(i18n.messages ?? {}, i18n.fallbackLocale ?? 'en', (key, locale) =>
      this.logger.warn(`Missing message "${key}" (language: ${locale ?? 'none'})`),
    );
    this.locales = Object.fromEntries(Object.entries(i18n.locales ?? {}).map(([locale, texts]) => [normalizeLocale(locale), texts]));
    this.localeFn = i18n.locale;
    this.fallbackLocale = i18n.fallbackLocale ?? 'en';
    this.relays = new RelayStore(this.sessionStorage);
    this.relayFilter = options.relay?.filter;
    this.localeNames = [...new Set([...Object.keys(i18n.messages ?? {}), ...Object.keys(i18n.locales ?? {})].map(normalizeLocale))];

    this.logger = options.logger === false ? silentLogger : options.logger ?? createConsoleLogger();
    this.parseMode = options.parseMode ?? 'markdown';
    this.homePage = options.homePage ?? 'home';
    this.middlewares = options.middlewares ?? [];
    this.menu = options.menu;
    this.protectContent = options.protectContent ?? false;
    this.scopeKeysByBot = options.scopeKeysByBot ?? true;
    this.prepareProactive = options.prepareProactive;
    this.emitProactiveErrors = options.emitProactiveErrors ?? false;
  }

  // ---- registration --------------------------------------------------------

  /** Register pages, dialogues (they share one id namespace) and tasks. */
  register(...items: Array<Registrable<C> | Registrable<C>[]>): this {
    for (const item of items.flat()) {
      if (item.kind === 'task') {
        if (!item.runFn) throw new EasyTGError(`Task "${item.id}" has no handler: call .run(...) before registering`);
        const run = item.runFn;
        this.scheduler.define(item.id, (args) => run({ ...args, app: this }), item.options);
        continue;
      }
      if (this.pages.has(item.id) || this.dialogueDefs.has(item.id)) {
        throw new EasyTGError(`"${item.id}" is already registered`);
      }
      if (item.kind === 'page') {
        if (!item.renderFn) throw new EasyTGError(`Page "${item.id}" has no render: call .render(...) before registering`);
        this.pages.set(item.id, item);
      } else {
        if (!item.stepsDef || !item.finishFn) {
          throw new EasyTGError(`Dialogue "${item.id}" needs .steps(...) and .onFinish(...) before registering`);
        }
        this.dialogueDefs.set(item.id, item);
      }
    }
    return this;
  }

  /**
   * A `/command` that opens a page or starts a dialogue (registered here if
   * it isn't yet). With a `description` it is listed in Telegram's command
   * menu by `app.syncCommands(bot)`.
   *
   *   app.command('start', home, { description: 'Main menu' });
   *   app.command(['find', 'search'], search, { params: (args) => ({ q: args }) });
   */
  command(names: string | string[], target: Page<any, any, any> | Dialogue<any, any, any>, options: CommandOptions = {}): this {
    const registered = target.kind === 'page' ? this.pages.get(target.id) : this.dialogueDefs.get(target.id);
    if (!registered) this.register(target as Registrable<C>);
    else if (registered !== target) throw new EasyTGError(`Another page or dialogue is registered as "${target.id}"`);
    this.commands.add(names, target, options);
    return this;
  }

  /**
   * Set Telegram's command menu from the commands with a `description`:
   * for all chats, and separately for private chats and groups when some
   * commands are only for those. With translated descriptions, once more per
   * language of `i18n.messages` / `i18n.locales`. Call it at startup.
   */
  async syncCommands(bot: Pick<BotLike, 'api'>): Promise<void> {
    const languages = this.commands.translated ? [...new Set(this.localeNames.map((l) => l.split('-')[0]!))] : [];
    for (const language of [undefined, ...languages]) {
      const locale = language ?? this.fallbackLocale;
      for (const { scope, commands } of this.commands.lists(locale, this.translator.for(locale))) {
        const other = { scope, ...(language ? { language_code: language as never } : {}) };
        if (commands?.length) await bot.api.setMyCommands(commands, other);
        else await bot.api.deleteMyCommands(other);
      }
    }
  }

  /**
   * Two users talking through the bot: messages in one's private chat are
   * copied to the other's, until `end` (or `ttlMs`). /commands, menu
   * buttons, dialogues and buttons keep working as usual.
   *
   *   await app.relay.start(ctx, ctx.from.id, otherUserId);
   *   await app.relay.end(ctx, ctx.from.id);
   */
  readonly relay: RelayApi = {
    start: async (bot, userA, userB, options = {}) => {
      const botId = relayBotId(bot);
      const { ended } = await this.relays.start(botId, userA, userB, options);
      for (const users of ended) await this.emit('relayEnd', { botId, users, reason: 'app' });
    },
    end: async (bot, userId) => {
      const botId = relayBotId(bot);
      const link = await this.relays.end(botId, userId);
      if (link) await this.emit('relayEnd', { botId, users: [userId, link.peer], reason: 'app' });
      return link;
    },
    peer: (bot, userId) => this.relays.get(relayBotId(bot), userId),
  };

  hasPage(id: string) {
    return this.pages.has(id);
  }

  /** @internal */
  findDialogue(id: string) {
    return this.dialogueDefs.get(id);
  }

  private page(target: Page<any, any, any> | string): Page<any, C, any> {
    const id = typeof target === 'string' ? target : target.id;
    const page = this.pages.get(id);
    if (!page) throw new EasyTGError(`Page "${id}" is not registered`);
    return page;
  }

  private dialogue(target: Dialogue<any, any, any>): Dialogue<any, any, C> {
    const dialogue = this.dialogueDefs.get(target.id);
    if (!dialogue) throw new EasyTGError(`Dialogue "${target.id}" is not registered`);
    return dialogue;
  }

  // ---- public API ----------------------------------------------------------

  /** Use as `bot.use(app)`, before your other handlers. */
  middleware(): MiddlewareFn<C> {
    return async (ctx, next) => {
      const started = Date.now();
      let outcome: UpdateOutcome = 'error'; // unless run() returns
      try {
        outcome = await flows.run({ key: this.userKey(ctx), ctx, queues: new Set() }, () => this.run(ctx, next));
      } finally {
        if (this.listeners.get('update')?.size) {
          await this.emit('update', { ctx, durationMs: Date.now() - started, outcome });
        }
      }
    };
  }

  /** The update pipeline. Returns how the update ended, for the `update` event. */
  private async run(ctx: C, next: () => Promise<void>): Promise<UpdateOutcome> {
    // The lock is requested before anything is awaited, so a user's updates keep
    // their order; the rate limit is checked meanwhile, so waiting doesn't delay it.
    const abort = new AbortController();
    const locking = this.lockUpdate(ctx, abort.signal);
    const unlock = async () => {
      abort.abort(); // stop waiting for the lock
      const release = await locking;
      if (typeof release === 'function') await release();
    };
    let passes: boolean;
    try {
      passes = await this.passesSpamCheck(ctx);
    } catch (error) {
      await unlock();
      throw error;
    }
    if (!passes) {
      await unlock();
      return 'limited';
    }
    const release = await locking;
    if (release === 'busy') {
      await this.answerCallback(ctx, { text: this.textsFor(ctx).busy });
      return 'busy';
    }
    let passedOn = false;
    try {
      await this.handleUpdate(ctx, async () => {
        passedOn = true;
        await next();
      });
    } finally {
      await this.releaseHeld(ctx);
      await release?.();
    }
    return passedOn ? 'next' : 'easytg';
  }

  private async handleUpdate(ctx: C, next: () => Promise<void>) {
    this.scope(ctx).inUpdate = true;
    const live = this.userKey(ctx);
    if (live !== undefined) this.liveUpdates.set(live, ctx);
    let failed = false;
    try {
      if (this.payments && ctx.preCheckoutQuery) {
        await this.handlePreCheckout(ctx, ctx.preCheckoutQuery);
        return;
      }
      if (this.payments && ctx.message?.successful_payment) {
        if (!(await this.handlePayment(ctx, ctx.message.successful_payment))) await next();
        return;
      }
      if (ctx.callbackQuery?.data) {
        if (await this.handleCallback(ctx)) return;
      } else if (ctx.message) {
        if (await this.handleMenu(ctx)) return;
        if (await this.handleMessage(ctx)) return;
        if (await this.handleDeepLink(ctx)) return;
        if (await this.handleCommand(ctx)) return;
        if (await this.handleRelay(ctx)) return;
        if (await this.handleTextInput(ctx)) return;
        const webAppData = ctx.message.web_app_data;
        if (webAppData) {
          // From a replyMenu.webApp button (a dialogue's webApp step took its own already).
          await this.emit('webAppData', { ctx, data: parseWebAppData(webAppData.data), raw: webAppData.data, button: webAppData.button_text });
        }
      }
      await next();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Sessions and stored buttons changed anywhere in this update are saved once, here.
      try {
        await this.flush(ctx);
      } catch (error) {
        if (!failed) throw error;
        this.logger.error('Failed to save state', error);
      } finally {
        if (live !== undefined && this.liveUpdates.get(live) === ctx) this.liveUpdates.delete(live);
      }
    }
  }

  /**
   * The per-user lock of an update: undefined = no lock needed (or waited too
   * long), 'busy' = a button pressed while the user's previous update runs.
   */
  private async lockUpdate(ctx: C, signal: AbortSignal): Promise<Release | undefined | 'busy'> {
    const userId = ctx.from?.id;
    if (userId === undefined || (!ctx.message && !ctx.callbackQuery)) return undefined;
    const key = this.userKey(ctx)!;
    const data = ctx.callbackQuery?.data;
    if (data !== undefined && (decodeStoredToken(data) || decodeInline(data))) {
      // One button press per user at a time: a press while busy is answered, not queued.
      return (await this.locks.tryAcquire(key)) ?? 'busy';
    }
    if (this.sequentialTimeoutMs === undefined) return undefined;
    const release = await this.locks.acquire(key, this.sequentialTimeoutMs, signal);
    if (!release && !signal.aborted) this.logger.debug(`Update of user ${userId} waited ${this.sequentialTimeoutMs} ms for the previous one; handling it anyway`);
    return release ?? undefined;
  }

  /** Render a page into the chat (see `DeliveryMode`, default `auto`). */
  open<P>(ctx: C, page: Page<P, any, any>, ...args: OpenArgs<P>): Promise<DeliveryResult | undefined>;
  open(ctx: C, page: string, params?: ParamsInput, options?: OpenOptions): Promise<DeliveryResult | undefined>;
  async open(ctx: C, target: Page<any, any, any> | string, params?: ParamsInput, options: OpenOptions = {}) {
    const page = this.page(target);
    return this.show(ctx, page.id, options.mode ?? 'auto', () => this.renderPage(ctx, page, normalizeParams(params)));
  }

  /** Render (`render` belongs to page `pageId`), deliver, and record the view. */
  private async show(ctx: C, pageId: string, mode: DeliveryMode, render: () => Promise<RenderResult>, depth = 0) {
    const scope = this.scope(ctx);
    const sourceId = ctx.callbackQuery?.message?.message_id ?? scope.editTarget?.messageId;
    const editing = sourceId !== undefined && (mode === 'edit' || mode === 'auto');

    // Navigating within a menu message pushes the page it showed onto its back stack.
    if (!scope.navStack) {
      const entry = editing ? (await this.navHistory(ctx))[sourceId] : undefined;
      scope.navStack = !entry
        ? []
        : entry.current.id === pageId
          ? entry.stack // same page with other params (pagination, filters): not a new step
          : [...entry.stack, entry.current].slice(-MAX_BACK_STEPS);
    }

    const started = Date.now();
    let previousTarget: { value: EditTarget | undefined } | undefined;
    try {
      const own = this.pages.get(pageId)?.loadingOptions;
      const loading = own === undefined ? this.defaultLoading : own;
      const result = loading ? await this.withPlaceholder(ctx, loading, render) : await render();
      // A placeholder message was sent while rendering: the page replaces it.
      let target = editing ? sourceId : undefined;
      if (scope.placeholder) {
        previousTarget = { value: scope.editTarget };
        scope.editTarget = scope.placeholder;
        scope.placeholder = undefined;
        target = scope.editTarget.messageId;
        mode = 'edit';
      }
      const delivered = await this.present(ctx, result, mode, depth);
      if (delivered && scope.view) {
        await this.recordView(ctx, delivered, target);
        await this.scheduleRefresh(ctx, delivered, target);
        const inPlace = delivered === true || (target !== undefined && delivered.message_id === target);
        await this.emit('pageView', {
          ctx,
          page: scope.view.id,
          params: scope.view.params,
          mode: inPlace ? 'edit' : 'send',
          chatId: ctx.chat?.id ?? scope.editTarget?.chatId,
          userId: ctx.from?.id,
          durationMs: Date.now() - started,
        });
      }
      await this.flush(ctx);
      return delivered;
    } finally {
      scope.navStack = undefined;
      scope.view = undefined;
      scope.refreshEveryMs = undefined;
      // The placeholder was this page's target only: later opens in this update start fresh.
      if (previousTarget) scope.editTarget = previousTarget.value;
    }
  }

  /**
   * An API transformer that spaces the bot's outgoing messages to stay within
   * Telegram's limits (30/s overall, 20/min per group by default; your own
   * rules per chat). Counted in this process, or across processes with
   * `cluster`. Install it once per bot:
   *
   *   bot.api.config.use(app.throttle());
   *   bot.api.config.use(app.throttle({ privateChat: { limit: 1, perMs: 1000 }, chat: (id) => (id === VIP ? false : undefined) }));
   */
  throttle(options: ThrottleOptions = {}): Transformer {
    return createThrottle(this.coordination, options);
  }

  /**
   * Run `job` and, if it takes longer than `afterMs`, show loading indicators
   * meanwhile: a repeated chat action ("typing…"), a toast, a placeholder
   * message (deleted when the job is done). For your own slow handlers:
   *
   *   const answer = await app.withLoading(ctx, () => askModel(q), { action: 'typing', text: '⏳ Thinking…' });
   */
  async withLoading<T>(ctx: C, job: () => Awaitable<T>, options: LoadingOptions = { action: 'typing' }): Promise<T> {
    const placeholder = { message: undefined as { chatId: number; messageId: number } | undefined };
    try {
      return await this.loadingAround(ctx, options, job, async (text) => {
        const delivery = await this.deliverContent(ctx, { text }, 'send');
        const chatId = ctx.chat?.id;
        if (delivery && delivery.result !== true && chatId !== undefined) placeholder.message = { chatId, messageId: delivery.result.message_id };
      });
    } finally {
      const message = placeholder.message;
      if (message) await ctx.api.deleteMessage(message.chatId, message.messageId).catch(() => {});
    }
  }

  /**
   * @internal Loading for renders: the placeholder is what the page will
   * replace. `fresh`: always a new placeholder message (the pressed message
   * may be gone, e.g. a dialogue prompt).
   */
  async withPlaceholder<T>(ctx: C, options: LoadingOptions, job: () => Awaitable<T>, fresh = false): Promise<T> {
    const scope = this.scope(ctx);
    let restore: (() => Promise<unknown>) | undefined;
    try {
      return await this.loadingAround(ctx, options, job, async (text) => {
        const pressed = ctx.callbackQuery?.message as Message | undefined;
        if (pressed && !fresh) {
          // A text menu shows the placeholder (and no buttons, so it isn't pressed again); media gets a toast.
          if (pressed.text !== undefined) {
            restore = () =>
              ctx.api.editMessageText(pressed.chat.id, pressed.message_id, pressed.text!, { entities: pressed.entities, reply_markup: pressed.reply_markup });
            await this.deliverContent(ctx, { text }, 'edit');
          } else if (typeof text === 'string') await this.answerCallback(ctx, { text });
          return;
        }
        if (scope.editTarget && !fresh) {
          await this.deliverContent(ctx, { text }, 'edit'); // app.edit: in the message itself
          return;
        }
        const delivery = await this.deliverContent(ctx, { text }, 'send');
        const chatId = ctx.chat?.id;
        if (delivery && delivery.result !== true && chatId !== undefined) scope.placeholder = { chatId, messageId: delivery.result.message_id };
      });
    } catch (error) {
      // The render failed: don't leave a placeholder behind (a menu gets its buttons back).
      const placeholder = scope.placeholder;
      scope.placeholder = undefined;
      if (placeholder) await ctx.api.deleteMessage(placeholder.chatId, placeholder.messageId).catch(() => {});
      await restore?.().catch(() => {});
      throw error;
    }
  }

  private async loadingAround<T>(ctx: C, options: LoadingOptions, job: () => Awaitable<T>, showText: (text: TextInput) => Promise<void>): Promise<T> {
    const chatId = ctx.chat?.id ?? this.scope(ctx).editTarget?.chatId;
    let interval: ReturnType<typeof setInterval> | undefined;
    let shown: Promise<void> | undefined;
    let done = false;
    const action = () => {
      if (options.action && chatId !== undefined) {
        void ctx.api.sendChatAction(chatId, options.action, { message_thread_id: threadIdOf(ctx) }).catch(() => {});
      }
    };
    const show = async () => {
      // The repeated action starts before anything is awaited, so `finally` always sees (and stops) it.
      if (options.action) {
        action();
        interval = setInterval(action, 4000); // Telegram shows an action for about 5 s
      }
      if (options.toast) await this.answerCallback(ctx, { text: options.toast });
      if (options.text !== undefined && !done) await showText(options.text);
    };
    const timer = setTimeout(() => {
      shown = show().catch((error) => this.logger.debug('Failed to show the loading indicator', error));
    }, options.afterMs ?? 500);
    try {
      return await job();
    } finally {
      done = true;
      clearTimeout(timer);
      clearInterval(interval);
      await shown; // the placeholder must exist before the result replaces it
    }
  }

  /** `refreshEveryMs`: render the page into its message again later (one task per message). */
  private async scheduleRefresh(ctx: C, delivered: DeliveryResult, sourceId: number | undefined) {
    const scope = this.scope(ctx);
    const every = scope.refreshEveryMs;
    const messageId = delivered === true ? sourceId : delivered.message_id;
    const chatId = ctx.chat?.id ?? scope.editTarget?.chatId;
    if (chatId === undefined) return;
    const idOf = (message: number) => `${REFRESH_TASK}:${ctx.me.id}:${chatId}:${message}`;
    try {
      // The message now shows something else (whoever navigated it), or moved to a new message:
      // a refresh scheduled for it must not bring the old page back.
      if (sourceId !== undefined && (!every || sourceId !== messageId)) await this.scheduler.cancel(idOf(sourceId));
      if (!every || !scope.view || messageId === undefined) return;
      if (every < 5000) throw new EasyTGError('refreshEveryMs must be at least 5000');
      const payload: RefreshPayload = {
        chatId,
        messageId,
        userId: ctx.from?.id,
        threadId: threadIdOf(ctx),
        allowedUsers: this.allowedUsers(ctx),
        page: scope.view.id,
        params: scope.view.params,
      };
      await this.scheduler.schedule(REFRESH_TASK, payload, { delayMs: every, id: idOf(messageId), botId: ctx.me.id });
    } catch (error) {
      if (error instanceof EasyTGError && String(error).includes('refreshEveryMs')) throw error;
      if (every) this.logger.error('refreshEveryMs: could not schedule the refresh', error);
    }
  }

  /**
   * @internal Show a render result that doesn't come from a page render (a
   * dialogue's onFinish / onCancel, a middleware stopping a dialogue, a
   * payment) the way pages are shown: a redirect is recorded for Back, onText
   * and the `pageView` event.
   */
  showResult(ctx: C, result: RenderResult, mode: DeliveryMode, depth = 0): Promise<DeliveryResult | undefined> {
    return this.show(ctx, result instanceof Redirect ? result.target : '', mode, async () => result, depth);
  }

  /** @internal Whether the page being rendered has a page to go back to. */
  canGoBack(ctx: C): boolean {
    return (this.scopes.get(ctx)?.navStack?.length ?? 0) > 0;
  }

  private async navHistory(ctx: C): Promise<NavHistory> {
    const history = (await this.state(ctx)).get<NavHistory>(NAV_KEY);
    return history && typeof history === 'object' ? history : {};
  }

  private async recordView(ctx: C, delivered: DeliveryResult, sourceId: number | undefined) {
    const scope = this.scope(ctx);
    const messageId = delivered === true ? sourceId : delivered.message_id;
    if (messageId === undefined || !scope.view) return;
    const session = await this.state(ctx);
    const history = { ...(await this.navHistory(ctx)) };
    if (sourceId !== undefined && sourceId !== messageId) delete history[sourceId]; // the menu moved to a new message
    history[messageId] = { current: scope.view, stack: scope.navStack ?? [], at: Date.now() };
    // Keep the most recently used menus (integer keys iterate in numeric order, not insertion order).
    const ids = Object.keys(history).sort((a, b) => (history[a]!.at ?? 0) - (history[b]!.at ?? 0));
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_NAV_MESSAGES))) delete history[old];
    session.set(NAV_KEY, history);
    // The last page shown decides where the user's text goes (`page.onText`).
    if (this.pages.get(scope.view.id)?.textFn) session.set(INPUT_KEY, { ...scope.view, messageId } satisfies TextInputState);
    else session.delete(INPUT_KEY);
  }

  /**
   * Send a page without an incoming update (notifications, cron jobs,
   * webhooks). `target` is a chat id or `{ chatId, userId?, threadId? }`.
   * The page receives a minimal `ctx`, see `isProactive`.
   */
  sendTo<P>(bot: BotLike, target: number | SendTarget, page: Page<P, any, any>, ...args: ParamArgs<P>): Promise<DeliveryResult | undefined>;
  sendTo(bot: BotLike, target: number | SendTarget, page: string, params?: ParamsInput): Promise<DeliveryResult | undefined>;
  async sendTo(bot: BotLike, target: number | SendTarget, page: Page<any, any, any> | string, params?: ParamsInput) {
    const ctx = await this.proactiveContext(bot, typeof target === 'number' ? { chatId: target } : target);
    return this.reportingProactive(ctx, 'sendTo', () =>
      this.asUser(ctx, () => this.open(ctx, typeof page === 'string' ? page : page.id, params, { mode: 'send' })),
    );
  }

  /** sendTo without error events (broadcast reports failures in its result). */
  private async deliverTo(bot: BotLike, target: number | SendTarget, pageId: string, params?: ParamsInput) {
    const ctx = await this.proactiveContext(bot, typeof target === 'number' ? { chatId: target } : target);
    return this.asUser(ctx, () => this.open(ctx, pageId, params, { mode: 'send' }));
  }

  /**
   * Run a proactive render in step with the user's own updates: share the
   * session of an update of this user that is being handled right now in this
   * process (e.g. `sendTo` from that update's handler), or else take the
   * user's lock, so neither overwrites the other's session changes.
   */
  private async asUser<T>(ctx: C, run: () => Promise<T>): Promise<T> {
    const key = userKey(ctx);
    const flow: Flow = { key, ctx, queues: new Set() };
    // Sharing the session of an update of this user (see proactiveContext): it holds the lock.
    if (this.scope(ctx).sharedWith) return flows.run(flow, run);
    const release = key !== undefined && this.sequentialTimeoutMs !== undefined ? await this.locks.acquire(key, this.sequentialTimeoutMs) : null;
    try {
      return await flows.run(flow, run);
    } finally {
      await release?.();
    }
  }

  private async reportingProactive<T>(ctx: C, source: 'sendTo' | 'edit', run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (this.emitProactiveErrors) await this.emit('error', { error, ctx, source });
      throw error;
    }
  }

  /**
   * Re-render a page into an existing message without an incoming update, e.g.
   * to update a status card after something happened elsewhere. Returns
   * undefined (and sends nothing) when the message can't be edited.
   *
   *   await app.edit(bot, { chatId, messageId }, orderCard, { id: '42' });
   */
  edit<P>(bot: BotLike, target: EditMessageTarget, page: Page<P, any, any>, ...args: ParamArgs<P>): Promise<DeliveryResult | undefined>;
  edit(bot: BotLike, target: EditMessageTarget, page: string, params?: ParamsInput): Promise<DeliveryResult | undefined>;
  async edit(bot: BotLike, target: EditMessageTarget, page: Page<any, any, any> | string, params?: ParamsInput) {
    const ctx = await this.proactiveContext(bot, target);
    const scope = this.scope(ctx);
    scope.editTarget = { chatId: target.chatId, messageId: target.messageId };
    scope.noFallback = true;
    return this.reportingProactive(ctx, 'edit', () =>
      this.asUser(ctx, () => this.open(ctx, typeof page === 'string' ? page : page.id, params, { mode: 'edit' })),
    );
  }

  private async proactiveContext(bot: BotLike, target: SendTarget): Promise<C> {
    if (!bot.isInited()) await bot.init();
    const ctx = createProactiveContext(bot.api, bot.botInfo, target) as C;
    const key = userKey(ctx);
    // Called from inside this user's own update (a handler, a listener, a middleware, …),
    // or while one of their updates runs elsewhere in this process: share its session.
    const flow = flows.get();
    const live = key === undefined ? undefined : flow?.key === key && flow.ctx ? flow.ctx : this.liveUpdates.get(key);
    if (live) this.scope(ctx).sharedWith = live;
    await this.prepareProactive?.(ctx);
    return ctx;
  }

  /**
   * Send a page to many chats, paced to Telegram's limits. Each recipient gets
   * their own render (their session, their language). Rate limits (429) are
   * retried; users who blocked the bot are reported in `blockedChats`.
   *
   *   const result = await app.broadcast(bot, userIds, newsPage, { params: { id: '42' } });
   */
  async broadcast<P>(
    bot: BotLike,
    targets: Iterable<number | SendTarget>,
    page: Page<P, any, any>,
    ...[options]: {} extends P ? [options?: BroadcastOptions<P>] : [options: BroadcastOptions<P>]
  ): Promise<BroadcastResult> {
    const { params, ...settings } = (options ?? {}) as BroadcastOptions<Params>;
    this.page(page); // fail fast if it isn't registered
    return runBroadcast(targets, (target) => this.deliverTo(bot, target, page.id, params), settings);
  }

  /**
   * A broadcast that survives restarts: the targets are saved as scheduled
   * tasks of `batchSize` recipients, spaced to `perSecond`, and sent by
   * `startScheduler` (in any process). Each finished batch emits
   * `broadcastBatch` with its result (blocked chats, failures). Returns the
   * broadcast id and the number of batches.
   *
   *   await app.broadcastLater(subscriberIds, newsPage, { params: { id: '42' }, botId: bot.botInfo.id });
   */
  async broadcastLater<P>(
    targets: Iterable<number | SendTarget>,
    page: Page<P, any, any>,
    ...[options]: {} extends P ? [options?: BroadcastLaterOptions<P>] : [options: BroadcastLaterOptions<P>]
  ): Promise<{ id: string; batches: number }> {
    const { params, batchSize = 100, perSecond = 25, concurrency, delayMs, at, botId } = (options ?? {}) as BroadcastLaterOptions<Params>;
    this.page(page);
    const list = [...targets];
    const id = `_easytg:broadcast:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const start = at instanceof Date ? at.getTime() : at ?? Date.now() + (delayMs ?? 0);
    const batches = Math.ceil(list.length / batchSize);
    for (let batch = 0; batch < batches; batch++) {
      const payload: BroadcastBatchPayload = {
        broadcast: id,
        batch,
        batches,
        targets: list.slice(batch * batchSize, (batch + 1) * batchSize),
        page: page.id,
        params: normalizeParams(params),
        perSecond,
        concurrency,
      };
      // Spaced so the batches together keep to `perSecond`.
      await this.scheduler.schedule(BROADCAST_TASK, payload, { at: start + Math.round((batch * batchSize * 1000) / perSecond), id: `${id}:${batch}`, botId });
    }
    return { id, batches };
  }

  /**
   * A page as an inline-mode result (`@yourbot query` in any chat), with its
   * buttons: pressing them later updates the sent message in place. Text
   * pages become articles, photo pages photos. Middlewares run as usual.
   *
   *   bot.on('inline_query', async (ctx) => {
   *     const results = await Promise.all(found.map((p) => app.inlineResult(ctx, product, { params: { id: p.id }, title: p.name })));
   *     await ctx.answerInlineQuery(results, { cache_time: 0 });
   *   });
   */
  async inlineResult<P>(ctx: C, page: Page<P, any, any>, options: InlineResultOptions<P>): Promise<InlineQueryResult> {
    const scope = this.scope(ctx);
    try {
      let result = await this.renderPage(ctx, this.page(page), normalizeParams(options.params as ParamsInput));
      for (let depth = 0; result instanceof Redirect; depth++) {
        if (depth >= MAX_REDIRECTS) throw new EasyTGError(`Too many redirects (last: "${result.target}")`);
        result = await this.renderPage(ctx, this.page(result.target), result.params);
      }
      if (!result || result instanceof DialogueStart) throw new EasyTGError(`Page "${page.id}" has no content to show as an inline result`);
      const prepared = prepareContent(result, this.parseMode, this.protectContent);
      if (!prepared) throw new EasyTGError(`Page "${page.id}" has no content to show as an inline result`);
      if (prepared.chunks.length > 1) this.logger.warn(`Inline result "${page.id}": text too long, only the first part is shown`);
      await this.flushCallbacks(scope); // stored buttons must exist before the result is sent
      await this.flush(ctx);

      const id = options.id ?? inlineResultId(page.id, options.params as ParamsInput);
      const text = prepared.chunks[0]!;
      const reply_markup = prepared.reply_markup.inline_keyboard.length ? prepared.reply_markup : undefined;
      const { title, description, thumbnailUrl } = options;
      const media = prepared.media;
      if (media) {
        if (media.type !== 'photo' || typeof media.source !== 'string') {
          throw new EasyTGError(`Inline result "${page.id}": only text and photo (file id or URL) pages can be inline results`);
        }
        const caption = { caption: text || undefined, parse_mode: text ? prepared.parse_mode : undefined, reply_markup, title, description };
        return /^https?:\/\//i.test(media.source)
          ? { type: 'photo', id, photo_url: media.source, thumbnail_url: thumbnailUrl ?? media.source, ...caption }
          : { type: 'photo', id, photo_file_id: media.source, ...caption };
      }
      if (!text) throw new EasyTGError(`Inline result "${page.id}": a text page needs text`);
      return {
        type: 'article',
        id,
        title,
        description,
        thumbnail_url: thumbnailUrl,
        input_message_content: { message_text: text, parse_mode: prepared.parse_mode, link_preview_options: prepared.link_preview_options },
        reply_markup,
      };
    } finally {
      scope.view = undefined;
    }
  }

  /**
   * Work as a user outside an update: a Mini App's request to your server, a
   * webhook from a payment provider, an admin panel. You get their session
   * (in their private chat with the bot, or `chatId`), their user session,
   * `t` in their language and a `nav`; changes are saved when `fn` ends,
   * in step with the user's own updates (the same lock).
   *
   *   const { user } = verifyInitData(initData, token);
   *   await app.withUser(bot, user!.id, async ({ userSession }) => userSession.set('plan', 'pro'));
   */
  async withUser<T>(bot: BotLike, target: number | SendTarget, fn: (args: WithUserArgs<C>) => Awaitable<T>): Promise<T> {
    const userTarget = typeof target === 'number' ? { chatId: target, userId: target } : target;
    if (userTarget.userId === undefined) throw new EasyTGError('withUser needs a userId');
    const ctx = await this.proactiveContext(bot, userTarget);
    return this.asUser(ctx, async () => {
      const session = await this.session(ctx);
      const userSession = await this.userSession(ctx);
      const result = await fn({ ctx, session, userSession, locale: this.localeOf(ctx), t: this.t(ctx), nav: this.nav(ctx), app: this });
      await this.flush(ctx);
      return result;
    });
  }

  /**
   * Answer a Mini App opened from an inline button or the menu button: the
   * page is sent into the chat as a message from the user, and the Mini App
   * closes. `queryId` and `userId` come from the verified initData.
   *
   *   const init = verifyInitData(body.initData, token);
   *   await app.answerWebAppQuery(bot, init.queryId!, orderCard, { userId: init.user!.id, params: { id }, title: 'Order' });
   */
  async answerWebAppQuery<P>(bot: BotLike, queryId: string, page: Page<P, any, any>, options: InlineResultOptions<P> & { userId: number }) {
    const result = await this.renderAsInline(bot, options.userId, page, options);
    return bot.api.answerWebAppQuery(queryId, result);
  }

  /**
   * Prepare a page as a message the user can share into any chat from a Mini
   * App: pass the returned `id` to `Telegram.WebApp.shareMessage(id)`.
   * By default it may go to users, groups and channels.
   */
  async prepareShare<P>(
    bot: BotLike,
    userId: number,
    page: Page<P, any, any>,
    options: InlineResultOptions<P> & { allowUserChats?: boolean; allowBotChats?: boolean; allowGroupChats?: boolean; allowChannelChats?: boolean },
  ): Promise<{ id: string; expirationDate: Date }> {
    const result = await this.renderAsInline(bot, userId, page, options);
    const { allowUserChats = true, allowBotChats = false, allowGroupChats = true, allowChannelChats = true } = options;
    // Through `raw`, so it works with grammY versions that don't know the method yet.
    const prepared = (await (bot.api.raw as unknown as Record<string, (payload: object) => Promise<{ id: string; expiration_date: number }>>)
      .savePreparedInlineMessage!({
      user_id: userId,
      result,
      allow_user_chats: allowUserChats,
      allow_bot_chats: allowBotChats,
      allow_group_chats: allowGroupChats,
      allow_channel_chats: allowChannelChats,
    }));
    return { id: prepared.id, expirationDate: new Date(prepared.expiration_date * 1000) };
  }

  /** A page rendered for a user as an inline result, with buttons anyone in the target chat may press. */
  private async renderAsInline<P>(bot: BotLike, userId: number, page: Page<P, any, any>, options: InlineResultOptions<P>) {
    const ctx = await this.proactiveContext(bot, { chatId: userId, userId });
    this.scope(ctx).inlineRender = true;
    return this.asUser(ctx, () => this.inlineResult(ctx, page, options));
  }

  /** Start a dialogue for the user of `ctx` (middlewares run first). */
  startDialogue<P>(ctx: C, dialogue: Dialogue<any, P, any>, ...args: ParamArgs<P>): Promise<void>;
  async startDialogue(ctx: C, dialogue: Dialogue<any, any, any>, params?: ParamsInput) {
    await this.guardedDialogueStart(ctx, this.dialogue(dialogue), normalizeParams(params), { mode: 'auto', closeMenu: false });
    await this.flush(ctx);
  }

  /** Cancel the active dialogue (runs `onCancel`, result ignored). Returns false if none. */
  async cancelDialogue(ctx: C) {
    const cancelled = await this.dialogues.cancel(ctx, { render: false, reason: 'app' });
    await this.flush(ctx);
    return cancelled;
  }

  /** Listen to an event. Returns a function that removes the listener. */
  on<K extends keyof EasyTGEvents<C>>(event: K, listener: (event: EasyTGEvents<C>[K]) => unknown): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => void set.delete(listener);
  }

  /** @internal */
  async emit<K extends keyof EasyTGEvents<C>>(event: K, payload: EasyTGEvents<C>[K]): Promise<number> {
    const set = this.listeners.get(event);
    if (!set?.size) return 0;
    for (const listener of set) {
      try {
        await listener(payload);
      } catch (error) {
        this.logger.error(`"${event}" listener failed`, error);
      }
    }
    return set.size;
  }

  // ---- scheduled tasks -----------------------------------------------------

  /**
   * Run a registered task later. Returns the task id (to `cancelTask` it).
   * Tasks are saved in storage and run by `startScheduler` (in any process).
   *
   *   await app.schedule(remind, { userId, text }, { delayMs: 60 * 60_000 });
   *   await app.schedule(digest, undefined, { at: nextMonday, everyMs: 7 * 24 * 3600_000, id: 'weekly-digest' });
   */
  schedule<P>(task: Task<P, any>, ...[payload, options]: ScheduleArgs<P>): Promise<string> {
    return this.scheduler.schedule(task.id, payload, options);
  }

  /** Cancel a scheduled task. Returns false if it doesn't exist (anymore). */
  cancelTask(id: string): Promise<boolean> {
    return this.scheduler.cancel(id);
  }

  /**
   * Delete messages later, e.g. a captcha or a "wrong answer" note. `target`
   * is the ctx of the chat, or `{ chatId, botId? }`.
   *
   *   const note = await ctx.reply('Wrong code');
   *   await app.deleteLater(ctx, note.message_id, { delayMs: 10_000 });
   */
  deleteLater(target: Context | { chatId: number; botId?: number }, messageIds: number | number[], options: DeleteLaterOptions): Promise<string> {
    const ctx = 'update' in target ? target : undefined; // (a Context has a `chatId` getter too)
    const chatId = ctx ? ctx.chat?.id : (target as { chatId: number }).chatId;
    if (chatId === undefined) throw new EasyTGError('deleteLater: no chat');
    const botId = ctx ? ctx.me.id : (target as { botId?: number }).botId;
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    return this.scheduler.schedule(DELETE_TASK, { chatId, messageIds: ids }, { ...options, botId });
  }

  /**
   * Send a page later, like `sendTo` (the page is rendered when it is sent).
   * With several bots, pass `botId` (`ctx.me.id`).
   *
   *   await app.sendLater(userId, reminderPage, { params: { lesson: '2' }, delayMs: 24 * 3600_000 });
   */
  sendLater<P>(target: number | SendTarget, page: Page<P, any, any>, options: SendLaterOptions<P>): Promise<string>;
  sendLater(target: number | SendTarget, page: string, options: SendLaterOptions<Params>): Promise<string>;
  sendLater(target: number | SendTarget, page: Page<any, any, any> | string, options: SendLaterOptions<Params>) {
    const pageId = this.page(page).id;
    const { params, ...when } = options;
    return this.scheduler.schedule(SEND_TASK, { target, page: pageId, params: normalizeParams(params as ParamsInput) }, when);
  }

  /**
   * Run scheduled tasks as they become due, with these bots (a task runs with
   * the bot it was scheduled for, else the first one). Returns `stop`, which
   * waits for running tasks. Safe to run in several processes at once.
   */
  startScheduler(...bots: TaskBot[]): () => Promise<void> {
    return this.scheduler.start(bots);
  }

  /** Run the tasks that are due now, once (e.g. from a cron job on serverless). Returns how many ran. */
  runDueTasks(...bots: TaskBot[]): Promise<number> {
    return this.scheduler.runDue(bots);
  }

  private defineBuiltinTasks() {
    this.scheduler.define(DELETE_TASK, async ({ payload, bot }) => {
      const { chatId, messageIds } = payload as { chatId: number; messageIds: number[] };
      try {
        await bot.api.deleteMessages(chatId, messageIds);
      } catch (error) {
        if (isTransient(error)) throw error; // retried by the scheduler
        // Already deleted, too old, or the bot left the chat: nothing left to do.
        if (!isMessageNotFound(error) && !isChatUnreachable(error)) this.logger.warn('deleteLater: could not delete messages', error);
      }
    });
    this.scheduler.define(
      BROADCAST_TASK,
      async ({ payload, bot, task }) => {
        const job = payload as BroadcastBatchPayload;
        // Claimed again: the first run outlived its lease (or its process died). Sending
        // the batch again would reach its recipients twice.
        if (task.attempts > 1) {
          this.logger.warn(`broadcastLater: batch ${job.batch + 1}/${job.batches} of ${job.broadcast} was started before; not sending it again`);
          return;
        }
        if (!this.pages.has(job.page)) throw new EasyTGError(`broadcastLater: page "${job.page}" is not registered`);
        const result = await runBroadcast(job.targets, (target) => this.deliverTo(bot, target, job.page, job.params), job);
        await this.emit('broadcastBatch', { broadcast: job.broadcast, batch: job.batch, batches: job.batches, result });
      },
      // A retry would send the whole batch again.
      { maxAttempts: 1 },
    );
    this.scheduler.define(REFRESH_TASK, async ({ payload, bot }) => {
      const { chatId, messageId, userId, threadId, allowedUsers, page, params } = payload as RefreshPayload;
      if (!this.pages.has(page)) return;
      // Showing another page in the message cancels this task, so it still shows this one.
      const ctx = await this.proactiveContext(bot, { chatId, userId, threadId, allowedUsers });
      const scope = this.scope(ctx);
      scope.editTarget = { chatId, messageId };
      scope.noFallback = true;
      scope.refreshing = true;
      // The render schedules the next refresh if it still asks for one; a deleted message stops it.
      await this.asUser(ctx, () => this.open(ctx, page, params, { mode: 'edit' }));
    });
    this.scheduler.define(SEND_TASK, async ({ payload, bot }) => {
      const { target, page, params } = payload as { target: number | SendTarget; page: string; params: Record<string, string> };
      try {
        await this.sendTo(bot, target, page, params);
      } catch (error) {
        if (isChatUnreachable(error)) return;
        // Part of the page went out already: a retry would send it twice.
        if (sentBeforeError(error)) return void this.logger.error('sendLater: the page was only partly sent', error);
        throw error; // retried
      }
    });
  }

  // ---- queues --------------------------------------------------------------

  /**
   * Run `job` within the concurrency limit of a queue (see the `queues`
   * option), waiting for a free slot first. Pass `ctx` for `perUser` limits
   * and the `queueWait` event. Throws `QueueFullError` / `QueueTimeoutError`.
   *
   *   const answer = await app.queue('ai', () => askModel(prompt), { ctx });
   */
  async queue<T>(name: string, job: () => Awaitable<T>, options: { ctx?: C } = {}): Promise<T> {
    const flow = flows.get();
    // Called from inside a job (or an update) that holds a slot of this queue: don't wait for ourselves.
    if (flow?.queues.has(name)) return job();
    const release = await this.takeSlot(name, options.ctx);
    try {
      return await flows.run({ key: flow?.key, ctx: flow?.ctx, queues: new Set([...(flow?.queues ?? []), name]) }, job);
    } finally {
      await release();
    }
  }

  /**
   * Wait for a slot in a queue; it is held until this update is handled
   * (after your handlers ran). Only inside update handling, e.g.:
   *
   *   bot.command('ask', async (ctx) => {
   *     await app.enterQueue(ctx, 'ai');
   *     await ctx.reply(await askModel(ctx.match));
   *   });
   */
  async enterQueue(ctx: C, name: string): Promise<void> {
    const scope = this.scope(ctx);
    if (!scope.inUpdate) throw new EasyTGError('enterQueue works while handling an update; use app.queue(name, job) elsewhere');
    const flow = flows.get();
    if (flow?.queues.has(name)) return; // this update holds a slot already
    (scope.held ??= []).push(await this.takeSlot(name, ctx));
    flow?.queues.add(name);
  }

  private takeSlot(name: string, ctx?: C): Promise<Release> {
    const queue = this.queues.get(name);
    if (!queue) throw new EasyTGError(`Queue "${name}" is not configured: add it to the \`queues\` option`);
    return queue.acquire(ctx?.from?.id, (position) => this.emit('queueWait', { ctx, queue: name, position }));
  }

  private async releaseHeld(ctx: C) {
    const scope = this.scopes.get(ctx);
    if (!scope?.held) return;
    for (const release of scope.held.splice(0)) await release();
  }

  /**
   * Ignore all updates from a user for `ms`, on one bot or (without `botId`)
   * on every bot. Works even with `antiSpam: false`.
   */
  limitUser(userId: number, ms: number, botId?: number): Promise<void> {
    return this.spamGuard.block(userId, botId === undefined ? '*' : String(botId), ms);
  }

  /** Lift limits set by anti-spam or `limitUser`: on one bot (and the every-bot limit), or all. */
  releaseUser(userId: number, botId?: number): Promise<void> {
    return this.spamGuard.release(userId, botId);
  }

  /** Whether a user is limited on a bot, or (without `botId`) on any bot. */
  isLimited(userId: number, botId?: number): Promise<boolean> {
    return this.spamGuard.isBlocked(userId, botId);
  }

  /** False when the update must be dropped: the user is limited. */
  private async passesSpamCheck(ctx: C): Promise<boolean> {
    const userId = ctx.from?.id;
    if (userId === undefined) return true;
    // Payments always go through, even from limited users: the money is already moving.
    if (ctx.preCheckoutQuery || ctx.message?.successful_payment) return true;
    const config = this.antiSpam;
    // Only user interactions count towards the limit (and `exempt` users never
    // count), but a limited user's updates are all dropped.
    const counts = !!config && (config.filter ? config.filter(ctx) : isInteraction(ctx)) && !config.exempt?.(ctx);

    // Counted per bot, so one instance can serve several bots; manual limits may cover all of them.
    const botId = ctx.me.id;
    const verdict = await this.spamGuard.check(botId, userId, counts);
    if (verdict.status === 'ok') return true;

    let silenced = false;
    if (verdict.status === 'limited') {
      this.logger.warn(`User ${userId} exceeded the rate limit (strike ${verdict.strike})`);
      await this.emit('spam', {
        ctx,
        userId,
        chatId: ctx.chat?.id,
        count: verdict.count,
        windowMs: this.spamGuard.windowMs,
        strike: verdict.strike,
        until: verdict.until,
        silence: () => void (silenced = true),
      });
      // A listener may have released the user.
      if (!(await this.isLimited(userId, botId))) return true;
    }

    const warn = verdict.status === 'limited' && config?.warn && !silenced;
    const seconds = Math.ceil(((verdict as { until?: number }).until ?? Date.now()) - Date.now()) / 1000;
    const text = warn ? this.textsFor(ctx).spam(Math.max(1, Math.ceil(seconds))) : undefined;
    if (ctx.callbackQuery) {
      await this.answerCallback(ctx, text ? { text, show_alert: true } : undefined);
    } else if (text && ctx.chat?.type === 'private') {
      try {
        await ctx.reply(text);
      } catch (error) {
        this.logger.debug('Failed to send spam warning', error);
      }
    }
    return false;
  }

  /** Send `text` with the main menu (the `menu` option) on the reply keyboard. */
  async showMenu(ctx: C, text: TextInput) {
    if (!this.menu) throw new EasyTGError('No menu configured: pass `menu: replyMenu([...])` to new EasyTG()');
    const result = await this.deliverContent(ctx, { text }, 'send', this.menu.markup(this.localeOf(ctx), this.textsFor(ctx).closeMenu, this.t(ctx)));
    await this.flush(ctx);
    return result?.result;
  }

  /** Send `text` and remove the reply keyboard. */
  async hideMenu(ctx: C, text: TextInput) {
    const result = await this.deliverContent(ctx, { text }, 'send', { remove_keyboard: true });
    await this.flush(ctx);
    return result?.result;
  }

  /** The session of the user in `ctx`. Loaded once per update. */
  session(ctx: C): Promise<Session> {
    return this.state(ctx);
  }

  /**
   * @internal The session of the user in this chat, where easytg keeps its own
   * state (dialogues, navigation, text input). Same as `session(ctx)`.
   * Loading it also resolves the user's language.
   */
  state(ctx: C): Promise<Session> {
    const scope = this.scope(ctx);
    const live = scope.sharedWith;
    if (live && !scope.session) {
      // The same session object as the update being handled, so both see (and save) each other's changes.
      scope.session = this.state(live as C).then((session) => {
        scope.locale = this.scopes.get(live)?.locale ?? null;
        scope.stateValue = session;
        return session;
      });
    }
    scope.session ??= (async () => {
      // The language is the user's, in every chat: kept in the user session, if the app is translated.
      const translated = !this.translator.isEmpty || Object.keys(this.locales).length > 0;
      const [session, user] = await Promise.all([this.loadSession(ctx), translated && ctx.from ? this.userSession(ctx) : undefined]);
      const language = ctx.from?.language_code;
      // Remembered for messages sent without an update, which carry no language.
      if (user && language && !isProactive(ctx) && user.get(LAST_LANGUAGE_KEY) !== language) user.set(LAST_LANGUAGE_KEY, language);
      scope.locale = this.resolveLocale(ctx, session, user) ?? null;
      scope.stateValue = session;
      return session;
    })();
    return scope.session;
  }

  /**
   * The user's session across all chats (private chat, groups), next to the
   * per-chat `session`: for what belongs to the person, like a plan, a cart
   * or settings. Loaded once per update and saved with it; changes made by
   * the user's updates in other chats at the same time are merged per key.
   */
  userSession(ctx: C): Promise<Session> {
    const scope = this.scope(ctx);
    const live = scope.sharedWith;
    if (live && !scope.userSession) {
      scope.userSession = this.userSession(live as C).then((session) => (scope.userValue = session));
    }
    scope.userSession ??= (async () => {
      const key = userSessionKey(ctx, this.botScope(ctx));
      const session = key ? this.migrated(new Session(await this.sessionStorage.get(key))) : new Session();
      scope.userValue = session;
      return session;
    })();
    return scope.userSession;
  }

  /** @internal The session, once `session(ctx)` has been awaited. */
  loadedSession(ctx: C): Session {
    const session = this.scope(ctx).stateValue;
    if (!session) throw new EasyTGError('The session is not loaded yet: await app.session(ctx) first');
    return session;
  }

  /** The user's language: the `locale` option once the session is loaded, else `language_code`. */
  localeOf(ctx: C): string | undefined {
    const resolved = this.scopes.get(ctx)?.locale;
    return (resolved === undefined ? ctx.from?.language_code : resolved) ?? undefined;
  }

  /**
   * Your messages (`i18n.messages`) in the user's language, or in `locale`.
   * In renders, dialogues and middlewares use the `t` argument instead. If your
   * `i18n.locale` function reads the session, `await app.session(ctx)` first.
   *
   *   const t = app.t(ctx);
   *   await ctx.reply(t('welcome', { name: ctx.from.first_name }));
   */
  t(ctx: C | string | undefined): Translate {
    if (typeof ctx !== 'object') return this.translator.for(ctx);
    const scope = this.scope(ctx);
    return (scope.t ??= this.translator.live(() => this.localeOf(ctx)));
  }

  /**
   * Set the user's language (e.g. from a language picker), or `undefined` to
   * follow their Telegram app again. It is kept in the user session, so it
   * applies in every chat, to the rest of this update at once (`t`, built-in
   * texts), and to messages sent to them later (`sendTo`, `sendLater`,
   * `broadcast`). It wins over `i18n.locale`.
   */
  async setLocale(ctx: C, locale: string | undefined): Promise<void> {
    const session = await this.session(ctx);
    const user = await this.userSession(ctx);
    if (locale) user.set(LOCALE_KEY, locale);
    else user.delete(LOCALE_KEY);
    this.scope(ctx).locale = this.resolveLocale(ctx, session, user) ?? null;
  }

  /**
   * An explicit choice (`setLocale`), else `i18n.locale`, else the Telegram
   * app's language, else (for `sendTo` & co, which have no language) the one
   * the user had when they last wrote.
   */
  private resolveLocale(ctx: C, session: Session, user: Session | undefined): string | undefined {
    const chosen = user?.get<string>(LOCALE_KEY);
    if (chosen) return chosen;
    if (this.localeFn) return this.localeFn(ctx, session);
    return ctx.from?.language_code ?? user?.get<string>(LAST_LANGUAGE_KEY);
  }

  /** Built-in texts in the user's language. */
  textsFor(ctx: C): EasyTGTexts {
    const requested = this.localeOf(ctx);
    if (!requested) return this.texts;
    const locale = normalizeLocale(requested);
    const key = [locale, locale.split('-')[0]!].find((l) => Object.hasOwn(this.locales, l));
    if (!key) return this.texts;
    let texts = this.localeTexts.get(key);
    if (!texts) {
      texts = { ...this.texts, ...this.locales[key] };
      this.localeTexts.set(key, texts);
    }
    return texts;
  }

  /**
   * Deep link to a page or dialogue that calls `.allowDeepLink()`, for use
   * outside renders (inside, use `nav.deepLink`). Stored params are saved immediately.
   */
  deepLink<P>(bot: BotLike | string, target: Page<P, any, any> | Dialogue<any, P, any>, ...args: ParamsArgs<P>): Promise<string>;
  async deepLink(bot: BotLike | string, target: Page<any, any, any> | Dialogue<any, any, any>, params?: ParamsInput, options?: ButtonOptions) {
    let username: string;
    if (typeof bot === 'string') username = bot;
    else {
      if (!bot.isInited()) await bot.init();
      username = bot.botInfo.username;
    }
    const { payload, stored } = this.deepLinkPayload(target.id, params, options);
    if (stored) await this.deepLinks.write(stored.token, stored.entry);
    return deepLinkUrl(username, payload);
  }

  /** A `Nav` for keyboards built outside renders. Stored buttons are saved when the update finishes (or on `flush`). */
  nav(ctx: C): Nav<C> {
    return new Nav(this, ctx);
  }

  /** Save pending session changes and stored buttons now. */
  async flush(ctx: C) {
    const scope = this.scopes.get(ctx);
    if (!scope) return;
    await this.flushCallbacks(scope);
    if (scope.chatSession) {
      const key = chatSessionKey(ctx, this.botScope(ctx));
      if (key) await this.saveSession(await scope.chatSession, key, true);
    }
    if (scope.userSession) {
      const key = userSessionKey(ctx, this.botScope(ctx));
      if (key) await this.saveSession(await scope.userSession, key, true);
    }
    if (!scope.session) return;
    const key = sessionKey(ctx, this.botScope(ctx));
    if (key) await this.saveSession(await scope.session, key);
  }

  private async saveSession(session: Session, key: string, merge = false) {
    const now = Date.now();
    const ttl = this.sessionTtlMs;
    // Keep active users' sessions alive without writing on every update.
    const refresh =
      !!ttl && this.refreshSessions && session.savedAt !== undefined && now - session.savedAt > ttl / 2;
    if (!session.dirty && !refresh) return;

    session.dirty = false;
    // Shared by concurrent updates: keep what others changed meanwhile.
    if (merge) session.mergeWith(await this.sessionStorage.get(key));
    if (session.isEmpty) {
      session.savedAt = undefined;
      await this.sessionStorage.delete(key);
    } else {
      session.savedAt = now;
      await this.sessionStorage.set(key, session.serialize(now), ttl);
    }
  }

  // ---- update handling -----------------------------------------------------

  /** Handle an easytg button press. Returns false for callback data that isn't easytg's. */
  private async handleCallback(ctx: C): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    if (!data) return false;
    const token = decodeStoredToken(data);
    const inline = token ? null : decodeInline(data);
    if (!token && !inline) return false;

    // Double taps: an identical press right after the previous one finished is
    // dropped. (One press at a time is enforced by the update lock.)
    const pressKey = `press:${ctx.me.id}:${ctx.chat?.id}:${ctx.from?.id}`;
    const signature = `${ctx.callbackQuery?.message?.message_id ?? ctx.callbackQuery?.inline_message_id}|${data}`;
    if (this.doubleTapMs > 0 && (await this.coordination.get(pressKey)) === signature) {
      this.logger.debug('Ignored double tap');
      await this.answerCallback(ctx);
      return true;
    }

    try {
      await this.state(ctx); // resolves the user's language
      const texts = this.textsFor(ctx);
      let id: string;
      let params: Record<string, string>;
      if (token) {
        const resolved = await this.callbacks.resolve(token, ctx.from?.id, this.botScope(ctx));
        if (resolved.status !== 'ok') {
          const text = resolved.status === 'forbidden' ? texts.notYourMenu : texts.buttonExpired;
          await this.answerCallback(ctx, { text, show_alert: true });
          return true;
        }
        ({ id, params } = resolved);
      } else {
        ({ id, params } = inline!);
        // In `stored` mode, inline params can only come from a forged request;
        // in `signed` mode they need a valid signature.
        if (id !== DIALOGUE_BUTTON_ID && Object.keys(params).length > 0 && !this.acceptInline(ctx, id, params)) {
          this.logger.debug(`Rejected inline params for "${id}" (${this.callbackParams} mode)`);
          await this.answerCallback(ctx, { text: texts.buttonExpired, show_alert: true });
          return true;
        }
      }
      // Per-button delivery mode.
      const sendNew = params._m === 's';
      delete params._m;

      if (!(await this.isMenuOwner(ctx))) {
        await this.answerCallback(ctx, { text: texts.notYourMenu, show_alert: true });
        return true;
      }

      const page = this.pages.get(id);
      const dialogue = this.dialogueDefs.get(id);
      if (id === DIALOGUE_BUTTON_ID) {
        if (!(await this.dialogues.handleButton(ctx, params))) {
          await this.answerCallback(ctx, { text: texts.buttonExpired, show_alert: true });
        }
      } else if (id === BACK_ID) {
        await this.goBack(ctx);
      } else if (id === EXIT_ID) {
        await this.closeMessage(ctx);
        // The closed message can't take text anymore.
        const session = await this.state(ctx);
        if (session.get<TextInputState>(INPUT_KEY)?.messageId === ctx.callbackQuery?.message?.message_id) session.delete(INPUT_KEY);
      } else if (page) {
        await this.open(ctx, page.id, params, { mode: sendNew ? 'send' : 'edit' });
      } else if (dialogue) {
        await this.guardedDialogueStart(ctx, dialogue, params, { mode: sendNew ? 'send' : 'edit', closeMenu: !sendNew });
      } else {
        await this.answerCallback(ctx, { text: texts.pageNotFound, show_alert: true });
      }
    } catch (error) {
      if (error instanceof InvalidParamsError) {
        this.logger.debug('Rejected params', error);
        await this.answerCallback(ctx, { text: this.textsFor(ctx).pageNotFound, show_alert: true });
      } else {
        await this.reportError(error, ctx);
        await this.answerCallback(ctx, { text: this.textsFor(ctx).error, show_alert: true });
      }
    } finally {
      await this.answerCallback(ctx); // no-op if already answered
      if (this.doubleTapMs > 0) await this.coordination.set(pressKey, signature, this.doubleTapMs);
    }
    return true;
  }

  /** Whether inline params (from a client, so untrusted) may be used. Strips the signature. */
  private acceptInline(ctx: C, id: string, params: Record<string, string>, deepLink = false): boolean {
    if (this.callbackParams === 'stored') return false;
    if (this.callbackParams !== 'signed') return true;
    const signature = params._s;
    delete params._s;
    const scope = deepLink ? { botId: 0 } : { botId: ctx.me.id, chatId: ctx.chat?.id };
    return verify(this.secret!, scope, deepLink ? undefined : ctx.from?.id, id, params, signature);
  }

  /** `nav.back()`: show the previous page of this menu message, or the home page. */
  private async goBack(ctx: C) {
    const messageId = ctx.callbackQuery?.message?.message_id;
    const entry = messageId === undefined ? undefined : (await this.navHistory(ctx))[messageId];
    const previous = entry?.stack.at(-1);
    if (previous && this.pages.has(previous.id)) {
      this.scope(ctx).navStack = entry!.stack.slice(0, -1);
      await this.open(ctx, previous.id, previous.params, { mode: 'edit' });
    } else if (this.pages.has(this.homePage)) {
      await this.open(ctx, this.homePage, {}, { mode: 'edit' });
    } else {
      await this.answerCallback(ctx, { text: this.textsFor(ctx).pageNotFound, show_alert: true });
    }
  }

  /** A main-menu button: open its page / start its dialogue. False if the text isn't a menu label. */
  private async handleMenu(ctx: C): Promise<boolean> {
    const text = ctx.message?.text;
    if (!this.menu || text === undefined) return false;
    try {
      await this.state(ctx); // resolves the user's language
      const texts = this.textsFor(ctx);
      const target = this.menu.match(text, this.localeOf(ctx), texts.closeMenu, this.t(ctx));
      if (!target) return false;
      // Like a /command, a menu button leaves the current dialogue.
      if (this.cancelDialogueOnCommand) await this.dialogues.cancel(ctx, { render: false });
      if (target === 'close') {
        (await this.state(ctx)).delete(INPUT_KEY);
        await this.deliverContent(ctx, { text: texts.menuClosed, parseMode: 'plain' }, 'send', { remove_keyboard: true });
      }
      else if (target.kind === 'page') await this.open(ctx, this.page(target), {}, { mode: 'send' });
      else await this.guardedDialogueStart(ctx, this.dialogue(target), {}, { mode: 'send', closeMenu: false });
      return true;
    } catch (error) {
      await this.reportError(error, ctx);
      try {
        await ctx.reply(this.textsFor(ctx).error);
      } catch {}
      return true;
    }
  }

  /** Feed a message to the active dialogue. Returns false if there is none. */
  private async handleMessage(ctx: C): Promise<boolean> {
    try {
      return await this.dialogues.handleMessage(ctx);
    } catch (error) {
      await this.reportError(error, ctx);
      try {
        await ctx.reply(this.textsFor(ctx).error);
      } catch {}
      return true;
    }
  }

  /** Open the page / start the dialogue of a `/start <payload>` deep link. False if it isn't one of ours. */
  private async handleDeepLink(ctx: C): Promise<boolean> {
    const payload = startPayload(ctx.message?.text, ctx.me?.username);
    const decoded = payload ? decodeDeepLink(payload) : null;
    if (!decoded) return false;

    try {
      let id: string;
      let params: Record<string, string>;
      if (decoded.kind === 'stored') {
        const resolved = await this.deepLinks.resolve(decoded.token, undefined);
        if (resolved.status !== 'ok') return false;
        ({ id, params } = resolved);
      } else {
        ({ id, params } = decoded);
        if (Object.keys(params).length > 0 && !this.acceptInline(ctx, id, params, true)) return false;
      }

      const page = this.pages.get(id);
      const dialogue = this.dialogueDefs.get(id);
      if (page?.deepLinkEnabled) await this.open(ctx, page.id, params, { mode: 'send' });
      else if (dialogue?.deepLinkEnabled) await this.guardedDialogueStart(ctx, dialogue, params, { mode: 'send', closeMenu: false });
      else return false; // unknown or not linkable: let the app's own /start run
      return true;
    } catch (error) {
      await this.reportError(error, ctx);
      try {
        await ctx.reply(this.textsFor(ctx).error);
      } catch {}
      return true;
    }
  }

  /** A command from `app.command`. False if the message isn't one. */
  private async handleCommand(ctx: C): Promise<boolean> {
    if (!this.commands.size) return false;
    const found = this.commands.match(ctx.message, ctx.me?.username);
    if (!found) return false;
    try {
      (await this.state(ctx)).delete(INPUT_KEY); // a command moves on from the page's text input
      const { target, options } = found.entry;
      const params = normalizeParams(options.params?.(found.args));
      if (target.kind === 'page') await this.open(ctx, this.page(target), params);
      else await this.guardedDialogueStart(ctx, this.dialogue(target), params, { mode: 'send', closeMenu: false });
    } catch (error) {
      await this.reportError(error, ctx);
      try {
        await ctx.reply(this.textsFor(ctx).error);
      } catch {}
    }
    return true;
  }

  /** A message in a relay: copy it to the other user. False if the user isn't in one. */
  private async handleRelay(ctx: C): Promise<boolean> {
    const message = ctx.message;
    const from = ctx.from;
    if (!message || !from || message.chat.type !== 'private' || isCommand(message, ctx.me?.username)) return false;
    const botId = ctx.me.id;
    const link = await this.relays.get(botId, from.id);
    if (!link) return false;
    try {
      const verdict = this.relayFilter ? await this.relayFilter({ ctx, peer: link.peer }) : undefined;
      if (verdict === false) return true;
      if (typeof verdict === 'string') {
        await ctx.reply(verdict);
        return true;
      }
      await ctx.api.copyMessage(link.peer, message.chat.id, message.message_id);
      await this.emit('relayMessage', { ctx, from: from.id, to: link.peer, messageId: message.message_id });
    } catch (error) {
      if (isChatUnreachable(error)) {
        await this.relays.end(botId, from.id);
        await this.emit('relayEnd', { botId, users: [from.id, link.peer], reason: 'unreachable', ctx });
        return true;
      }
      await this.reportError(error, ctx);
      try {
        await ctx.reply(this.textsFor(ctx).error);
      } catch {}
    }
    return true;
  }

  private async handlePreCheckout(ctx: C, query: PreCheckoutQuery) {
    let answer: true | string;
    try {
      answer = this.payments!.preCheckout ? await this.payments!.preCheckout({ ctx, query, payload: query.invoice_payload }) : true;
    } catch (error) {
      await this.reportError(error, ctx);
      answer = this.textsFor(ctx).error;
    }
    await ctx.answerPreCheckoutQuery(answer === true, answer === true ? undefined : { error_message: answer });
  }

  /** Emit `payment` and show `onSuccess`'s result. False if there is no `onSuccess`. */
  private async handlePayment(ctx: C, payment: SuccessfulPayment): Promise<boolean> {
    const payload = payment.invoice_payload;
    await this.emit('payment', { ctx, payment, payload });
    const onSuccess = this.payments!.onSuccess;
    if (!onSuccess) return false;
    try {
      const session = await this.session(ctx);
      const args: PaymentArgs<C> = { ctx, payment, payload, session, locale: this.localeOf(ctx), t: this.t(ctx), nav: this.nav(ctx), app: this };
      await this.showResult(ctx, await onSuccess(args), 'send');
    } catch (error) {
      await this.reportError(error, ctx);
      try {
        await ctx.reply(this.textsFor(ctx).error);
      } catch {}
    }
    return true;
  }

  /** Text for the last page shown, if it has `onText`. False if there is none. */
  private async handleTextInput(ctx: C): Promise<boolean> {
    const message = ctx.message;
    if (message?.text === undefined) return false;
    const session = await this.state(ctx);
    if (isCommand(message)) {
      session.delete(INPUT_KEY); // a command moves on: later text isn't for the page anymore
      return false;
    }
    const input = session.get<TextInputState>(INPUT_KEY);
    if (!input || typeof input !== 'object') return false;
    const page = this.pages.get(input.id);
    if (!page?.textFn) {
      session.delete(INPUT_KEY);
      return false;
    }
    // In groups, only replies to the page's message are meant for it.
    if (message.chat.type !== 'private' && message.reply_to_message?.message_id !== input.messageId) return false;

    const { mode = 'send', deleteInput = false } = page.textOptions;
    try {
      if (mode === 'edit') this.scope(ctx).editTarget = { chatId: message.chat.id, messageId: input.messageId };
      await this.show(ctx, page.id, mode, () =>
        this.guard(ctx, page, input.params, async ({ target: _target, ...args }) => {
          this.scope(ctx).view = { id: page.id, params: input.params };
          return page.textFn!({ ...args, params: await this.parseParams(page, input.params), page, text: message.text! });
        }),
      );
      if (deleteInput) {
        await ctx.deleteMessage().catch((error: unknown) => this.logger.debug('Failed to delete the input message', error));
      }
    } catch (error) {
      if (error instanceof InvalidParamsError) {
        session.delete(INPUT_KEY);
        return false;
      }
      await this.reportError(error, ctx);
      try {
        await ctx.reply(this.textsFor(ctx).error);
      } catch {}
    } finally {
      this.scope(ctx).editTarget = undefined;
    }
    return true;
  }

  // ---- internals used by Nav / DialogueRunner -------------------------------

  /** @internal Callback data for a registered page/dialogue. */
  callbackData(ctx: C, id: string, params?: ParamsInput, options?: ButtonOptions): string {
    if (!this.pages.has(id) && !this.dialogueDefs.has(id)) {
      throw new EasyTGError(`"${id}" is not a registered page or dialogue`);
    }
    const normalized = normalizeParams(params);
    const reserved = Object.keys(normalized).find((key) => key.startsWith('_'));
    if (reserved) throw new EasyTGError(`Param "${reserved}" of "${id}": names starting with "_" are reserved`);
    if (options?.mode === 'send') normalized._m = 's';
    const store = options?.store || (this.callbackParams === 'stored' && Object.keys(normalized).length > 0);
    return this.encode(ctx, id, normalized, !!store);
  }

  /** @internal Deep link URL, used by `nav.deepLink` (stored params are saved with the render). */
  deepLinkFor(ctx: C, id: string, params?: ParamsInput, options?: ButtonOptions): string {
    const { payload, stored } = this.deepLinkPayload(id, params, options);
    if (stored) this.scope(ctx).pendingLinks.set(stored.token, stored.entry);
    return deepLinkUrl(ctx.me.username, payload);
  }

  private deepLinkPayload(id: string, params?: ParamsInput, options?: ButtonOptions) {
    const target = this.pages.get(id) ?? this.dialogueDefs.get(id);
    if (!target) throw new EasyTGError(`"${id}" is not a registered page or dialogue`);
    if (!target.deepLinkEnabled) throw new EasyTGError(`"${id}" doesn't allow deep links: call .allowDeepLink() on it`);

    const normalized = normalizeParams(params);
    const store = options?.store || (this.callbackParams === 'stored' && Object.keys(normalized).length > 0);
    if (!store) {
      const signed =
        this.callbackParams === 'signed' && Object.keys(normalized).length > 0
          ? { ...normalized, _s: sign(this.secret!, { botId: 0 }, id, normalized) }
          : normalized;
      const inline = encodeDeepLinkInline(id, signed);
      if (inline) return { payload: inline };
      if (this.callbackParams === 'inline') throw new EasyTGError(`Deep link params for "${id}" don't fit in 64 characters`);
    }
    // Not bound to a user: deep links are meant to be shared.
    const entry: StoredCallback = { p: id, q: normalized };
    const token = this.deepLinks.tokenFor(entry);
    return { payload: encodeDeepLinkStored(token), stored: { token, entry } };
  }

  /** @internal Callback data for dialogue controls (checked against dialogue state, so inline is fine). */
  controlData(ctx: C, params: ParamsInput): string {
    return this.encode(ctx, DIALOGUE_BUTTON_ID, normalizeParams(params), false);
  }

  private encode(ctx: C, id: string, params: Record<string, string>, store: boolean): string {
    const boundUser = this.boundUser(ctx);
    if (!store) {
      const signed =
        this.callbackParams === 'signed' && id !== DIALOGUE_BUTTON_ID && Object.keys(params).length > 0
          ? { ...params, _s: sign(this.secret!, { botId: ctx.me.id, chatId: ctx.chat?.id, userId: boundUser }, id, params) }
          : params;
      const inline = encodeInline(id, signed);
      if (fitsCallback(inline)) return inline;
      if (this.callbackParams === 'inline') assertFits(inline); // throws
    }
    const entry: StoredCallback = { p: id, q: params, u: boundUser };
    const token = this.callbacks.tokenFor(entry, ctx.chat?.id);
    this.scope(ctx).pending.set(token, entry);
    return `s|${token}`;
  }

  /**
   * The user a button is bound to: the one it was rendered for, when menus are
   * owner-only. Never for inline-mode messages (anyone in the chat may press
   * them) or messages with `allowedUsers` (checked through ownership instead).
   */
  private boundUser(ctx: C): number | undefined {
    const inlineMode = !!ctx.inlineQuery || !!ctx.callbackQuery?.inline_message_id || !!this.scopes.get(ctx)?.inlineRender;
    return this.ownerOnly && !inlineMode && !this.allowedUsers(ctx) ? ctx.from?.id : undefined;
  }

  /** Users allowed to press this render's buttons: from `sendTo`, or inherited from the pressed menu. */
  private allowedUsers(ctx: Context): number[] | undefined {
    return allowedUsersOf(ctx) ?? this.scopes.get(ctx)?.allowedUsers;
  }

  /** Storage scope of bot-specific data. */
  private botScope(ctx: Context): string {
    return this.scopeKeysByBot ? String(ctx.me.id) : '';
  }

  /** @internal Show a render result: content, redirect or dialogue start. */
  async present(ctx: C, result: RenderResult, mode: DeliveryMode, depth = 0): Promise<DeliveryResult | undefined> {
    if (!result) return undefined;

    if (result instanceof Redirect || result instanceof DialogueStart) {
      // Also counted per update: loops through a dialogue that finishes at once and redirects back.
      const scope = this.scope(ctx);
      scope.redirects = (scope.redirects ?? 0) + 1;
      if (scope.redirects > MAX_REDIRECTS * 4) {
        throw new EasyTGError(`Too many redirects in one update (last: "${result instanceof Redirect ? result.target : result.dialogueId}")`);
      }
    }

    if (result instanceof Redirect) {
      if (depth >= MAX_REDIRECTS) throw new EasyTGError(`Too many redirects (last: "${result.target}")`);
      const page = this.page(result.target);
      return this.present(ctx, await this.renderPage(ctx, page, result.params), mode, depth + 1);
    }

    if (result instanceof DialogueStart) {
      const dialogue = this.dialogueDefs.get(result.dialogueId);
      if (!dialogue) throw new EasyTGError(`Dialogue "${result.dialogueId}" is not registered`);
      return this.guardedDialogueStart(ctx, dialogue, result.params, { mode, closeMenu: true }, depth);
    }

    if (result.toast) {
      const toast = typeof result.toast === 'string' ? { text: result.toast } : result.toast;
      await this.answerCallback(ctx, { text: toast.text, show_alert: toast.alert });
    }
    return (await this.deliverContent(ctx, result, mode))?.result;
  }

  /** @internal Send/edit content; stored buttons are persisted before the message goes out. */
  async deliverContent(
    ctx: C,
    content: PageContent,
    mode: DeliveryMode,
    sendMarkup?: ReplyKeyboardMarkup | ReplyKeyboardRemove,
  ): Promise<Delivery | undefined> {
    const prepared = prepareContent(content, this.parseMode, this.protectContent);
    if (!prepared) return undefined;
    if (sendMarkup) {
      prepared.sendMarkup = sendMarkup;
      mode = 'send'; // reply keyboards can only come with a new message
    }
    const scope = this.scope(ctx);
    await this.flushCallbacks(scope);
    const delivery = await this.deliverCached(ctx, prepared, mode, scope);
    if (scope.view) scope.refreshEveryMs = content.refreshEveryMs;
    if (delivery?.sent.length && ctx.chat) {
      await this.emit('sent', { ctx, chatId: ctx.chat.id, messageIds: delivery.sent, page: scope.view?.id });
    }
    const chatId = ctx.chat?.id ?? scope.editTarget?.chatId;
    if (delivery && chatId !== undefined) {
      // The message is out already: a failure here must not fail the page.
      await this.autoDelete(ctx, chatId, delivery, content.deleteAfterMs).catch((error) => {
        this.logger.error('deleteAfterMs: could not schedule or cancel the deletion', error);
      });
    }
    return delivery;
  }

  /** `deliver`, sending remembered file ids instead of URLs (`media.cacheFileIds`). */
  private async deliverCached(ctx: C, prepared: PreparedContent, mode: DeliveryMode, scope: UpdateScope) {
    const options = { fallbackToSend: !scope.noFallback };
    const media = prepared.media;
    const url = this.cacheFileIds && media && typeof media.source === 'string' && /^https?:\/\//i.test(media.source) ? media.source : undefined;
    if (!url) return deliver(this, ctx, prepared, mode, scope.editTarget, options);

    const key = scoped('fileid', this.botScope(ctx), media!.type, toBase64Url(sha256(url)).slice(0, 32));
    const cached = await this.metaStorage.get(key);
    if (typeof cached === 'string') {
      try {
        return await deliver(this, ctx, { ...prepared, media: { ...media!, source: cached } }, mode, scope.editTarget, options);
      } catch (error) {
        if (!/file identifier|wrong file|file_id/i.test(String(error))) throw error;
        await this.metaStorage.delete(key); // no longer valid: send the URL again
      }
    }
    const delivery = await deliver(this, ctx, prepared, mode, scope.editTarget, options);
    const fileId = delivery && delivery.result !== true ? sentFileId(delivery.result, media!.type) : undefined;
    if (fileId) await this.metaStorage.set(key, fileId, this.fileIdTtlMs);
    return delivery;
  }

  /**
   * `deleteAfterMs`: schedule the deletion of what was just delivered. The
   * task is named after the message, so a later edit of the same message
   * replaces it (new `deleteAfterMs`) or cancels it (a page without one).
   */
  private async autoDelete(ctx: C, chatId: number, delivery: Delivery, deleteAfterMs: number | undefined) {
    // Edits may return `true` instead of the message: then it's the message that was edited.
    const target = this.scopes.get(ctx)?.editTarget?.messageId ?? ctx.callbackQuery?.message?.message_id;
    const edited = delivery.sent.length ? undefined : delivery.result === true ? target : delivery.result.message_id;
    const last = delivery.sent.at(-1) ?? edited;
    if (last === undefined) return;
    const id = `_easytg:del:${ctx.me.id}:${chatId}:${last}`;
    // Messages with a pending deletion, per user, so edits only cost a storage call when needed.
    const session = ctx.from ? await this.state(ctx) : undefined;
    const pending = session?.get<number[]>(AUTODELETE_KEY) ?? [];
    if (deleteAfterMs !== undefined) {
      // A page refreshing itself must not push its own deletion back: the first render scheduled it.
      if (this.scopes.get(ctx)?.refreshing) return;
      const ids = delivery.sent.length ? delivery.sent : [edited!];
      await this.scheduler.schedule(DELETE_TASK, { chatId, messageIds: ids }, { delayMs: deleteAfterMs, botId: ctx.me.id, id });
      if (session && !pending.includes(last)) session.set(AUTODELETE_KEY, [...pending, last].slice(-MAX_NAV_MESSAGES));
    } else if (edited !== undefined && pending.includes(edited)) {
      await this.scheduler.cancel(id);
      session!.set(AUTODELETE_KEY, pending.filter((m) => m !== edited));
    }
  }

  /** @internal Replace reply-keyboard buttons with the main menu (or remove them), with a short message. */
  async restoreKeyboard(ctx: C, text: string) {
    const markup = this.menu ? this.menu.markup(this.localeOf(ctx), this.textsFor(ctx).closeMenu, this.t(ctx)) : { remove_keyboard: true as const };
    await this.deliverContent(ctx, { text, parseMode: 'plain' }, 'send', markup);
  }

  /**
   * Answer the button press now, e.g. with "Working on it…" before something
   * slow, so the button's spinner stops. easytg then doesn't answer again (a
   * `toast` from the render is dropped). No-op outside button presses.
   */
  async answer(ctx: C, toast?: string | { text: string; alert?: boolean }): Promise<void> {
    const options = typeof toast === 'string' ? { text: toast } : toast && { text: toast.text, show_alert: toast.alert };
    await this.answerCallback(ctx, options);
  }

  /** The unit updates are serialized by: a user in a chat. */
  private userKey(ctx: Context): string | undefined {
    return userKey(ctx);
  }

  /** @internal Answer the current callback query once; later calls are no-ops. */
  async answerCallback(ctx: C, options?: { text?: string; show_alert?: boolean }) {
    const scope = this.scope(ctx);
    if (!ctx.callbackQuery || scope.answered) return;
    scope.answered = true;
    try {
      await ctx.answerCallbackQuery(options);
    } catch (error) {
      this.logger.debug('Failed to answer callback query', error);
    }
  }

  /** @internal Delete the pressed message; if it's too old to delete, strip its keyboard. */
  async closeMessage(ctx: C) {
    const message = ctx.callbackQuery?.message;
    if (!message && !ctx.callbackQuery?.inline_message_id) return;
    // Inline-mode messages can't be deleted by the bot: only strip the keyboard.
    if (message && (await removeWithGroup(this, ctx, message))) return;
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      this.logger.debug('Failed to remove keyboard', error);
    }
  }

  /** @internal Remember who a group menu belongs to, and which messages a long page was split into. */
  async onSent(ctx: Context, messages: SentMessage[]) {
    const last = messages.at(-1)!;
    const chatId = last.chat.id;
    const bot = this.botScope(ctx);
    const writes: Promise<void>[] = [];
    if (messages.length > 1) {
      const extra = messages.slice(0, -1).map((m) => m.message_id);
      writes.push(this.metaStorage.set(groupKey(bot, chatId, last.message_id), extra, OWNER_TTL_MS));
    }
    if (last.chat.type !== 'private') {
      // Who may press this message's buttons: explicit allowedUsers, or its user.
      const owners = this.allowedUsers(ctx) ?? (this.ownerOnly && ctx.from ? ctx.from.id : undefined);
      if (owners !== undefined) writes.push(this.metaStorage.set(ownerKey(bot, chatId, last.message_id), owners, OWNER_TTL_MS));
    }
    await Promise.all(writes);
  }

  /** @internal */
  async takeGroup(ctx: Context, chatId: number, messageId: number): Promise<number[]> {
    const key = groupKey(this.botScope(ctx), chatId, messageId);
    const ids = await this.metaStorage.get(key);
    if (!Array.isArray(ids) || ids.length === 0) return [];
    await this.metaStorage.delete(key);
    return ids.filter((id): id is number => typeof id === 'number');
  }

  // ---- private helpers -----------------------------------------------------

  private scope(ctx: Context): UpdateScope {
    let scope = this.scopes.get(ctx);
    if (!scope) {
      scope = { pending: new Map(), pendingLinks: new Map(), answered: false, botScope: this.botScope(ctx) };
      this.scopes.set(ctx, scope);
    }
    return scope;
  }

  /** Run the global + target middlewares, then `final`. */
  private async guard(
    ctx: C,
    target: Page<any, C, any> | Dialogue<any, any, C>,
    params: Params,
    final: (args: MiddlewareArgs<C>) => Promise<RenderResult>,
  ): Promise<RenderResult> {
    const session = await this.session(ctx);
    const args: MiddlewareArgs<C> = {
      ctx,
      params,
      session,
      locale: this.localeOf(ctx),
      t: this.t(ctx),
      nav: new Nav(this, ctx, target.kind === 'page' ? { id: target.id, params: params as Record<string, string> } : undefined),
      app: this,
      target,
    };
    const chain = [...this.middlewares, ...target.middlewares];
    const dispatch = async (i: number): Promise<RenderResult> =>
      i < chain.length ? chain[i]!(args, () => dispatch(i + 1)) : final(args);
    return dispatch(0);
  }

  private renderPage(ctx: C, page: Page<any, C, any>, params: Record<string, string>): Promise<RenderResult> {
    return this.guard(ctx, page, params, async ({ target: _target, ...args }) => {
      this.scope(ctx).view = { id: page.id, params };
      const renderArgs: RenderArgs<any, C> = { ...args, params: await this.parseParams(page, params), page };
      return page.renderFn!(renderArgs);
    });
  }

  /** Validation/conversion by `.params(parse)`; a throw rejects the request. */
  private async parseParams(page: Page<any, C, any>, params: Record<string, string>): Promise<unknown> {
    if (!page.parseFn) return params;
    try {
      return await page.parseFn(params);
    } catch (error) {
      throw error instanceof InvalidParamsError ? error : new InvalidParamsError(`Invalid params for "${page.id}": ${error}`);
    }
  }

  /** Start a dialogue unless a middleware stops it; a middleware's result is shown instead. */
  private async guardedDialogueStart(
    ctx: C,
    dialogue: Dialogue<any, any, C>,
    params: Record<string, unknown>,
    options: { mode: DeliveryMode; closeMenu: boolean },
    depth = 0,
  ): Promise<DeliveryResult | undefined> {
    if (depth >= MAX_REDIRECTS) throw new EasyTGError(`Too many redirects (last: dialogue "${dialogue.id}")`);
    let started = false;
    const result = await this.guard(ctx, dialogue, params as Params, async ({ session }) => {
      await this.dialogues.start(ctx, dialogue, params);
      session.delete(INPUT_KEY); // the dialogue takes the user's text now
      started = true;
      return undefined;
    });
    if (!started) return this.showResult(ctx, result, options.mode, depth + 1);
    // The dialogue prompt replaces the menu that started it.
    const fromMenu = ctx.callbackQuery && (options.mode === 'edit' || options.mode === 'auto');
    if (options.closeMenu && fromMenu) await this.closeMessage(ctx);
    return undefined;
  }

  private async loadSession(ctx: C): Promise<Session> {
    const key = sessionKey(ctx, this.botScope(ctx));
    if (!key) {
      // Normal for sendTo/edit to a group without a user; unexpected for updates.
      const message = 'No user for this context; using a temporary session that is not saved';
      if (isProactive(ctx)) this.logger.debug(message);
      else this.logger.warn(message);
      return new Session();
    }
    return this.migrated(new Session(await this.sessionStorage.get(key)));
  }

  private migrated(session: Session): Session {
    if (this.sessionVersion !== undefined) session.migrate(this.sessionVersion, this.migrateSession);
    return session;
  }

  /**
   * State shared by everyone in the chat (a group's settings, a game board),
   * next to each user's own `session`. Loaded once per update and saved with
   * it. Updates of different users can run at the same time, so for counters
   * that many users change at once, prefer an atomic store.
   */
  chatSession(ctx: C): Promise<Session> {
    const scope = this.scope(ctx);
    const live = scope.sharedWith;
    if (live && !scope.chatSession && live.chat?.id === ctx.chat?.id) scope.chatSession = this.chatSession(live as C);
    scope.chatSession ??= (async () => {
      const key = chatSessionKey(ctx, this.botScope(ctx));
      if (!key) throw new EasyTGError('chatSession needs a chat');
      return this.migrated(new Session(await this.sessionStorage.get(key)));
    })();
    return scope.chatSession;
  }

  private async flushCallbacks(scope: UpdateScope) {
    if (scope.pending.size === 0 && scope.pendingLinks.size === 0) return;
    const buttons = [...scope.pending];
    const links = [...scope.pendingLinks];
    scope.pending.clear();
    scope.pendingLinks.clear();
    const botScope = scope.botScope ?? '';
    await Promise.all([
      ...buttons.map(([token, entry]) => this.callbacks.write(token, entry, botScope)),
      ...links.map(([token, entry]) => this.deepLinks.write(token, entry)),
    ]);
  }

  private async isMenuOwner(ctx: C): Promise<boolean> {
    const message = ctx.callbackQuery?.message;
    const userId = ctx.from?.id;
    if (!message || userId === undefined || message.chat.type === 'private') return true;

    const key = ownerKey(this.botScope(ctx), message.chat.id, message.message_id);
    const owner = await this.metaStorage.get(key);
    const allowed = typeof owner === 'number' ? owner === userId : Array.isArray(owner) ? owner.includes(userId) : undefined;
    if (allowed !== undefined) {
      if (!allowed) return false;
      // A menu shared by several users stays shared in what this press renders.
      if (Array.isArray(owner)) this.scope(ctx).allowedUsers = owner.filter((id): id is number => typeof id === 'number');
      // Keep the ownership of a menu in use alive (it expires OWNER_TTL after the last press).
      await this.metaStorage.set(key, owner, OWNER_TTL_MS);
      return true;
    }
    if (!this.ownerOnly) return true;

    // Untracked (older) menu: fall back to the user it replied to.
    const repliedTo = (message as Message).reply_to_message?.from;
    if (repliedTo && !repliedTo.is_bot) return repliedTo.id === userId;
    return true;
  }

  private async reportError(error: unknown, ctx: C) {
    if ((await this.emit('error', { error, ctx, source: 'update' })) === 0) this.logger.error('Error while handling update', error);
  }
}

/** Default anti-spam scope: button presses, and messages with content in private chats or /commands in groups. */
function isInteraction(ctx: Context): boolean {
  if (ctx.callbackQuery) return true;
  const message = ctx.message;
  if (!message) return false;
  const content =
    message.text !== undefined ||
    !!(message.photo || message.video || message.animation || message.document || message.audio || message.voice || message.video_note || message.sticker);
  if (!content) return false;
  return message.chat.type === 'private' || isCommand(message);
}

/** A result id (≤ 64 bytes) that is the same for the same page and params. */
function inlineResultId(pageId: string, params: ParamsInput | undefined): string {
  const query = JSON.stringify(Object.entries(normalizeParams(params)).sort());
  return toBase64Url(sha256(`${pageId}|${query}`)).slice(0, 40);
}

/** The file id Telegram assigned to the media of a sent message. */
function sentFileId(message: Message, type: string): string | undefined {
  if (type === 'photo') return message.photo?.at(-1)?.file_id;
  const file = (message as unknown as Record<string, { file_id?: string } | undefined>)[type];
  return file?.file_id;
}

/**
 * What the current async flow runs as: the user (`userKey`) whose update or
 * proactive render it is, and the queue slots it holds. Anything called from
 * inside (handlers, listeners, middlewares, jobs) sees it, which tells nested
 * calls from concurrent ones.
 */
interface Flow {
  key?: string;
  ctx?: Context;
  queues: Set<string>;
}
const flows = new AsyncContext<Flow>();

/** One user in one chat of one bot: the unit updates are serialized by. */
function userKey(ctx: Context): string | undefined {
  const userId = ctx.from?.id;
  return userId === undefined ? undefined : `${ctx.me.id}:${ctx.chat?.id ?? 'global'}:${userId}`;
}

function userSessionKey(ctx: Context, bot: string): string | null {
  const userId = ctx.from?.id;
  return userId === undefined ? null : scoped('usersession', bot, userId);
}

/** `bot` is '' when keys aren't scoped by bot (`scopeKeysByBot: false`). */
function scoped(prefix: string, bot: string, ...parts: Array<string | number>) {
  return [prefix, ...(bot ? [bot] : []), ...parts].join(':');
}

function sessionKey(ctx: Context, bot: string): string | null {
  const userId = ctx.from?.id;
  if (userId === undefined) return null;
  return scoped('session', bot, ctx.chat?.id ?? 'global', userId);
}

function chatSessionKey(ctx: Context, bot: string): string | null {
  const chatId = ctx.chat?.id;
  return chatId === undefined ? null : scoped('chatsession', bot, chatId);
}

function ownerKey(bot: string, chatId: number, messageId: number) {
  return scoped('msgowner', bot, chatId, messageId);
}

function groupKey(bot: string, chatId: number, messageId: number) {
  return scoped('msggroup', bot, chatId, messageId);
}

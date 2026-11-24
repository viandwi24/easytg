// Public options, events and argument types of `EasyTG`, re-exported by ../engine.
import type { Bot, Context } from 'grammy';
import type { PreCheckoutQuery, SuccessfulPayment } from 'grammy/types';
import type { AntiSpamOptions, SpamEvent } from '../antispam';
import type { BroadcastResult, BroadcastSettings } from '../broadcast';
import type { CallbackParamsMode } from '../callback-store';
import type { QueueOptions } from '../coordination';
import type { EasyTG } from '../engine';
import type { ParseMode } from '../format';
import type { Messages, Translate } from '../i18n';
import type { Logger } from '../logger';
import type { ReplyMenu } from '../menu';
import type { Nav } from '../nav';
import type { SendTarget } from '../proactive';
import type { RelayBot, RelayEndReason, RelayLink, RelayStartOptions } from '../relay';
import type { DeliveryResult } from '../render';
import type { ScheduleOptions, SchedulerOptions, TaskErrorEvent } from '../scheduler';
import type { Session } from '../session';
import type { StorageAdapter } from '../storage';
import type { EasyTGTexts } from '../texts';
import type { Awaitable, DeliveryMode, DialogueCancelReason, LoadingOptions, Middleware, PageContent, Params, ParamsInputOf, RenderResult } from '../types';

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
  /**
   * The time zone of `date` steps: where "today" is, and which day a `Date`
   * falls on. An IANA name such as `Asia/Jakarta`. Default: the server's.
   */
  timeZone?: string;
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

/** What `app.stream` reads: chunks of text as they come (e.g. from an AI model). */
export type StreamSource = AsyncIterable<string> | ((signal: AbortSignal) => AsyncIterable<string>);

export interface StreamOptions {
  /** The final message, from the whole text: formatting, a keyboard, media… Default: the text, trimmed. */
  finish?: (text: string, info: { stopped: boolean }) => PageContent;
  /**
   * Private chats: show a stop button; pressing it aborts the source's signal
   * and the text so far becomes the final message. The stop arrives as an
   * update: with `bot.start()` (one update at a time) it waits for the
   * stream, so don't await `app.stream` in the handler there
   * (`void app.stream(…).catch(…)`); with webhooks or `@grammyjs/runner` you can.
   */
  stoppable?: boolean;
  /** Least time between preview updates. Default 300 ms (drafts), 1000 ms (edits, in groups). */
  intervalMs?: number;
  /**
   * The text is Rich Markdown (Bot API 10.3): previews are rich drafts (or
   * rich edits in groups) and the final message is a rich message, so an
   * answer with headings, tables and code shows formatted while it grows.
   * Default: previews are plain text and the final message is `text`.
   */
  rich?: boolean;
}

export interface StreamResult {
  text: string;
  /** The user pressed stop. */
  stopped: boolean;
  /** The final message (as `app.open` returns). */
  result: DeliveryResult | undefined;
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


export type BroadcastLaterOptions<P> = Omit<BroadcastSettings, 'onProgress' | 'signal'> &
  Pick<ScheduleOptions, 'delayMs' | 'at' | 'botId'> & {
    /** Recipients per scheduled task. Default 100. */
    batchSize?: number;
  } & ({} extends P ? { params?: ParamsInputOf<P> } : { params: ParamsInputOf<P> });

export type BotLike = Pick<Bot<any>, 'api' | 'botInfo' | 'isInited' | 'init'>;

/** The message `app.edit` updates. */
export type EditMessageTarget = SendTarget & { messageId: number };

import type { Bot, Context, MiddlewareFn, MiddlewareObj } from 'grammy';
import type { Message, ReplyKeyboardMarkup, ReplyKeyboardRemove } from 'grammy/types';
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
import { runBroadcast, type BroadcastResult, type BroadcastSettings } from './broadcast';
import { CallbackStore, type CallbackParamsMode, type StoredCallback } from './callback-store';
import type { Dialogue, Page } from './define';
import { DialogueRunner, isCommand } from './dialogue';
import { EasyTGError, InvalidParamsError } from './errors';
import type { ParseMode, TextInput } from './format';
import { createConsoleLogger, silentLogger, type Logger } from './logger';
import type { ReplyMenu } from './menu';
import { Nav } from './nav';
import { decodeDeepLink, deepLinkUrl, encodeDeepLinkInline, encodeDeepLinkStored, startPayload } from './deeplink';
import { allowedUsersOf, createProactiveContext, type SendTarget } from './proactive';
import { sign, verify } from './sign';
import {
  deliver,
  prepareContent,
  pressedMessage,
  removeWithGroup,
  type Delivery,
  type DeliveryResult,
  type EditTarget,
  type SentMessage,
} from './render';
import { Session } from './session';
import { MemoryStorage, withPrefix, type StorageAdapter } from './storage';
import { defaultTexts, type EasyTGTexts } from './texts';
import {
  DialogueStart,
  Redirect,
  type ButtonOptions,
  type DeliveryMode,
  type Middleware,
  type MiddlewareArgs,
  type PageContent,
  type Params,
  type ParamsInputOf,
  type RenderArgs,
  type RenderResult,
  type Awaitable,
} from './types';

const OWNER_TTL_SECONDS = 7 * 24 * 60 * 60;
const CALLBACK_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEEP_LINK_TTL_SECONDS = 365 * 24 * 60 * 60;
const MAX_REDIRECTS = 5;
/** Session key of the per-message navigation history behind `nav.back()`. */
const NAV_KEY = '_easytg:nav';
const MAX_BACK_STEPS = 10;
const MAX_NAV_MESSAGES = 20;

interface View {
  id: string;
  params: Record<string, string>;
}

/** Per menu message: the page it shows and the pages before it. */
type NavHistory = Record<string, { current: View; stack: View[] }>;

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
  dialogues?: DialoguesOptions;
  /** Rate limit per user. Default on (20 updates / 10 s); `false` disables. */
  antiSpam?: AntiSpamOptions<C> | false;
  i18n?: I18nOptions<C>;
}

export interface SessionOptions {
  /** Where sessions (incl. dialogue state) live. Default: `storage`. */
  storage?: StorageAdapter;
  /** Delete a session this many seconds after the user was last active. Default: never. */
  ttlSeconds?: number;
  /**
   * Any interaction keeps the session alive, not only changes. Default true.
   * To save writes, the expiry is refreshed once half of the TTL has passed.
   */
  refreshOnActivity?: boolean;
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
  ttlSeconds?: number;
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
  ttlSeconds?: number;
}

export interface DialoguesOptions {
  /** A /command sent during a dialogue cancels it (and the command still runs). Default true. */
  cancelOnCommand?: boolean;
}

export interface I18nOptions<C extends Context = Context> {
  /** Override built-in (English) labels and messages. */
  texts?: Partial<EasyTGTexts>;
  /** Built-in texts per language, merged over `texts`: `{ id: { cancel: '❌ Batal', … } }`. */
  locales?: Record<string, Partial<EasyTGTexts>>;
  /** The user's language. Default: `ctx.from.language_code`; `pt-br` falls back to `pt`. */
  locale?: (ctx: C, session: Session) => string | undefined;
}

/** Events emitted by `app.on(...)`. */
export interface EasyTGEvents<C extends Context = Context> {
  /** A user exceeded the anti-spam limit and is ignored until `until`. */
  spam: SpamEvent<C>;
  /** An error was caught while handling a button press, dialogue input or deep link. */
  error: { error: unknown; ctx: C };
  /** New messages were sent (all of them, for text split across several messages). */
  sent: { ctx: C; chatId: number; messageIds: number[]; page?: string };
  /** A page was shown: `send` as a new message, `edit` in place. */
  pageView: { ctx: C; page: string; params: Params; mode: 'send' | 'edit' };
  dialogueStart: { ctx: C; dialogue: string; params: Record<string, unknown> };
  dialogueFinish: { ctx: C; dialogue: string; answers: Record<string, unknown> };
  /**
   * A dialogue ended without finishing: `user` pressed Cancel, `command` a
   * /command or menu button took over, `replaced` another dialogue started.
   */
  dialogueCancel: { ctx: C; dialogue: string; answers: Record<string, unknown>; reason: 'user' | 'command' | 'replaced' };
}

export type BroadcastOptions<P> = BroadcastSettings & ({} extends P ? { params?: ParamsInputOf<P> } : { params: ParamsInputOf<P> });

export interface OpenOptions {
  /** How the page reaches the chat. Default `auto`: edit on button presses, reply otherwise. */
  mode?: DeliveryMode;
}

type Registrable<C extends Context> = Page<any, C, any> | Dialogue<any, any, C>;

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
}

type OpenArgs<P> = {} extends P
  ? [params?: ParamsInputOf<P>, options?: OpenOptions]
  : [params: ParamsInputOf<P>, options?: OpenOptions];

type ParamArgs<P> = {} extends P ? [params?: ParamsInputOf<P>] : [params: ParamsInputOf<P>];

type BotLike = Pick<Bot<any>, 'api' | 'botInfo' | 'isInited' | 'init'>;

/** The message `app.edit` updates. */
export type EditMessageTarget = SendTarget & { messageId: number };

export class EasyTG<C extends Context = Context> implements MiddlewareObj<C> {
  /** @internal */ readonly texts: EasyTGTexts;
  /** @internal */ readonly logger: Logger;
  /** @internal */ readonly homePage: string;
  /** @internal */ readonly cancelDialogueOnCommand: boolean;

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
  private readonly doubleTapMs: number;
  /** Users with a button press in progress (per process). */
  private readonly busy = new Set<string>();
  /** Last finished button press per user, for double-tap detection. */
  private readonly lastPress = new Map<string, { signature: string; at: number }>();
  private readonly sessionTtlSeconds?: number;
  private readonly refreshSessions: boolean;
  private readonly spamGuard: SpamGuard;
  private readonly antiSpam: AntiSpamOptions<C> | undefined;
  private readonly listeners = new Map<keyof EasyTGEvents<C>, Set<(event: any) => unknown>>();
  private readonly ownerOnly: boolean;
  private readonly menu?: ReplyMenu<C>;
  /** @internal */ readonly mediaToText: 'replace' | 'keep';
  private readonly protectContent: boolean;
  private readonly scopeKeysByBot: boolean;
  private readonly secret?: string;
  private readonly prepareProactive?: (ctx: C) => Awaitable<void>;

  constructor(options: EasyTGOptions<C> = {}) {
    const storage = options.storage ?? new MemoryStorage();
    const scoped = (adapter?: StorageAdapter) => withPrefix(adapter ?? storage, options.keyPrefix ?? '');
    const { session = {}, buttons = {}, deepLinks = {}, dialogues = {}, i18n = {} } = options;

    this.sessionStorage = scoped(session.storage);
    this.sessionTtlSeconds = session.ttlSeconds;
    this.refreshSessions = session.refreshOnActivity ?? true;

    this.metaStorage = scoped(buttons.storage);
    this.callbacks = new CallbackStore(this.metaStorage, buttons.ttlSeconds ?? CALLBACK_TTL_SECONDS);
    this.deepLinks = new CallbackStore(this.metaStorage, deepLinks.ttlSeconds ?? DEEP_LINK_TTL_SECONDS, 'dl:');
    this.callbackParams = buttons.params ?? 'auto';
    this.mediaToText = buttons.mediaToText ?? 'replace';
    this.secret = buttons.secret;
    if (this.callbackParams === 'signed' && (!this.secret || this.secret.length < 16)) {
      throw new EasyTGError("buttons.params 'signed' needs buttons.secret with at least 16 characters");
    }
    this.doubleTapMs = buttons.doubleTapMs ?? 700;
    this.ownerOnly = buttons.ownerOnly ?? true;

    this.cancelDialogueOnCommand = dialogues.cancelOnCommand ?? true;

    const antiSpam = options.antiSpam === false ? undefined : options.antiSpam ?? {};
    this.antiSpam = antiSpam && { warn: true, ...antiSpam };
    this.spamGuard = new SpamGuard(antiSpam?.limit ?? 20, antiSpam?.windowMs ?? 10_000, antiSpam?.cooldownMs ?? 30_000);

    this.texts = { ...defaultTexts, ...i18n.texts };
    this.locales = i18n.locales ?? {};
    this.localeFn = i18n.locale;

    this.logger = options.logger === false ? silentLogger : options.logger ?? createConsoleLogger();
    this.parseMode = options.parseMode ?? 'markdown';
    this.homePage = options.homePage ?? 'home';
    this.middlewares = options.middlewares ?? [];
    this.menu = options.menu;
    this.protectContent = options.protectContent ?? false;
    this.scopeKeysByBot = options.scopeKeysByBot ?? true;
    this.prepareProactive = options.prepareProactive;
  }

  // ---- registration --------------------------------------------------------

  /** Register pages and dialogues (ids share one namespace). */
  register(...items: Array<Registrable<C> | Registrable<C>[]>): this {
    for (const item of items.flat()) {
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
      if (!(await this.passesSpamCheck(ctx))) return;
      let failed = false;
      try {
        if (ctx.callbackQuery?.data) {
          if (await this.handleCallback(ctx)) return;
        } else if (ctx.message) {
          if (await this.handleMenu(ctx)) return;
          if (await this.handleMessage(ctx)) return;
          if (await this.handleDeepLink(ctx)) return;
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
        }
      }
    };
  }

  /** Render a page into the chat (see `DeliveryMode`, default `auto`). */
  open<P>(ctx: C, page: Page<P, any, any>, ...args: OpenArgs<P>): Promise<DeliveryResult | undefined>;
  open(ctx: C, page: string, params?: ParamsInput, options?: OpenOptions): Promise<DeliveryResult | undefined>;
  async open(ctx: C, target: Page<any, any, any> | string, params?: ParamsInput, options: OpenOptions = {}) {
    const page = this.page(target);
    const mode = options.mode ?? 'auto';
    const scope = this.scope(ctx);
    const sourceId = ctx.callbackQuery?.message?.message_id ?? scope.editTarget?.messageId;
    const editing = sourceId !== undefined && (mode === 'edit' || mode === 'auto');

    // Navigating within a menu message pushes the page it showed onto its back stack.
    if (!scope.navStack) {
      const entry = editing ? (await this.navHistory(ctx))[sourceId] : undefined;
      scope.navStack = !entry
        ? []
        : entry.current.id === page.id
          ? entry.stack // same page with other params (pagination, filters): not a new step
          : [...entry.stack, entry.current].slice(-MAX_BACK_STEPS);
    }

    try {
      const result = await this.renderPage(ctx, page, normalizeParams(params));
      const delivered = await this.present(ctx, result, mode);
      if (delivered && scope.view) {
        await this.recordView(ctx, delivered, editing ? sourceId : undefined);
        const inPlace = delivered === true || (editing && delivered.message_id === sourceId);
        await this.emit('pageView', { ctx, page: scope.view.id, params: scope.view.params, mode: inPlace ? 'edit' : 'send' });
      }
      await this.flush(ctx);
      return delivered;
    } finally {
      scope.navStack = undefined;
      scope.view = undefined;
    }
  }

  /** @internal Whether the page being rendered has a page to go back to. */
  canGoBack(ctx: C): boolean {
    return (this.scopes.get(ctx)?.navStack?.length ?? 0) > 0;
  }

  private async navHistory(ctx: C): Promise<NavHistory> {
    const history = (await this.session(ctx)).get<NavHistory>(NAV_KEY);
    return history && typeof history === 'object' ? history : {};
  }

  private async recordView(ctx: C, delivered: DeliveryResult, sourceId: number | undefined) {
    const scope = this.scope(ctx);
    const messageId = delivered === true ? sourceId : delivered.message_id;
    if (messageId === undefined || !scope.view) return;
    const session = await this.session(ctx);
    const history = { ...(await this.navHistory(ctx)) };
    if (sourceId !== undefined && sourceId !== messageId) delete history[sourceId]; // the menu moved to a new message
    delete history[messageId];
    history[messageId] = { current: scope.view, stack: scope.navStack ?? [] };
    const ids = Object.keys(history);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_NAV_MESSAGES))) delete history[old];
    session.set(NAV_KEY, history);
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
    return this.open(ctx, typeof page === 'string' ? page : page.id, params, { mode: 'send' });
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
    return this.open(ctx, typeof page === 'string' ? page : page.id, params, { mode: 'edit' });
  }

  private async proactiveContext(bot: BotLike, target: SendTarget): Promise<C> {
    if (!bot.isInited()) await bot.init();
    const ctx = createProactiveContext(bot.api, bot.botInfo, target) as C;
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
    return runBroadcast(targets, (target) => this.sendTo(bot, target, page.id, params), settings);
  }

  /** Start a dialogue for the user of `ctx` (middlewares run first). */
  startDialogue<P>(ctx: C, dialogue: Dialogue<any, P, any>, ...args: ParamArgs<P>): Promise<void>;
  async startDialogue(ctx: C, dialogue: Dialogue<any, any, any>, params?: ParamsInput) {
    await this.guardedDialogueStart(ctx, this.dialogue(dialogue), normalizeParams(params), { mode: 'auto', closeMenu: false });
    await this.flush(ctx);
  }

  /** Cancel the active dialogue (runs `onCancel`, result ignored). Returns false if none. */
  async cancelDialogue(ctx: C) {
    const cancelled = await this.dialogues.cancel(ctx, { render: false });
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

  /** Ignore all updates from a user for `ms` (works even with `antiSpam: false`). */
  limitUser(userId: number, ms: number) {
    this.spamGuard.block(userId, ms);
  }

  /** Lift a limit set by anti-spam or `limitUser`. */
  releaseUser(userId: number) {
    this.spamGuard.release(userId);
  }

  isLimited(userId: number) {
    return this.spamGuard.isBlocked(userId);
  }

  /** False when the update must be dropped: the user is limited. */
  private async passesSpamCheck(ctx: C): Promise<boolean> {
    const userId = ctx.from?.id;
    if (userId === undefined) return true;
    const config = this.antiSpam;
    // Only user interactions count, and only they are ever dropped: payments,
    // inline queries, member updates, reactions etc. always go through.
    const counts = config?.filter ? config.filter(ctx) : isInteraction(ctx);
    if (!counts || config?.exempt?.(ctx)) return true;

    const verdict = config ? this.spamGuard.check(userId) : this.spamGuard.isBlocked(userId) ? { status: 'blocked' as const } : { status: 'ok' as const };
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
      if (!this.spamGuard.isBlocked(userId)) return true;
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
    const result = await this.deliverContent(ctx, { text }, 'send', this.menu.markup(this.localeOf(ctx), this.textsFor(ctx).closeMenu));
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
    const scope = this.scope(ctx);
    scope.session ??= this.loadSession(ctx).then((session) => {
      scope.locale = (this.localeFn ? this.localeFn(ctx, session) : ctx.from?.language_code) ?? null;
      return session;
    });
    return scope.session;
  }

  /** The user's language: the `locale` option once the session is loaded, else `language_code`. */
  localeOf(ctx: C): string | undefined {
    const resolved = this.scopes.get(ctx)?.locale;
    return (resolved === undefined ? ctx.from?.language_code : resolved) ?? undefined;
  }

  /** Built-in texts in the user's language. */
  textsFor(ctx: C): EasyTGTexts {
    const locale = this.localeOf(ctx)?.toLowerCase();
    if (!locale) return this.texts;
    const key = this.locales[locale] ? locale : this.locales[locale.split('-')[0]!] ? locale.split('-')[0]! : undefined;
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
  deepLink<P>(bot: BotLike | string, target: Page<P, any, any> | Dialogue<any, P, any>, ...args: ParamArgs<P>): Promise<string>;
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
    if (!scope.session) return;
    const session = await scope.session;
    const key = sessionKey(ctx, this.botScope(ctx));
    if (!key) return;

    const now = Date.now();
    const ttl = this.sessionTtlSeconds;
    // Keep active users' sessions alive without writing on every update.
    const refresh =
      !!ttl && this.refreshSessions && session.savedAt !== undefined && now - session.savedAt > (ttl * 1000) / 2;
    if (!session.dirty && !refresh) return;

    session.dirty = false;
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

    // Double taps: one press per user at a time, and an identical press right
    // after the previous one finished is dropped.
    const userKey = `${ctx.chat?.id}:${ctx.from?.id}`;
    const signature = `${ctx.callbackQuery?.message?.message_id}|${data}`;
    if (this.busy.has(userKey)) {
      await this.answerCallback(ctx, { text: this.textsFor(ctx).busy });
      return true;
    }
    const last = this.lastPress.get(userKey);
    if (this.doubleTapMs > 0 && last?.signature === signature && Date.now() - last.at < this.doubleTapMs) {
      this.logger.debug('Ignored double tap');
      await this.answerCallback(ctx);
      return true;
    }
    this.busy.add(userKey);

    try {
      await this.session(ctx); // resolves the user's language
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
      this.busy.delete(userKey);
      this.rememberPress(userKey, signature);
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

  private rememberPress(userKey: string, signature: string) {
    const now = Date.now();
    this.lastPress.set(userKey, { signature, at: now });
    if (this.lastPress.size > 10_000) {
      for (const [key, press] of this.lastPress) if (now - press.at > this.doubleTapMs) this.lastPress.delete(key);
    }
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
      await this.session(ctx); // resolves the user's language
      const texts = this.textsFor(ctx);
      const target = this.menu.match(text, this.localeOf(ctx), texts.closeMenu);
      if (!target) return false;
      // Like a /command, a menu button leaves the current dialogue.
      if (this.cancelDialogueOnCommand) await this.dialogues.cancel(ctx, { render: false });
      if (target === 'close') await this.deliverContent(ctx, { text: texts.menuClosed, parseMode: 'plain' }, 'send', { remove_keyboard: true });
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
    const inlineMode = !!ctx.inlineQuery || !!ctx.callbackQuery?.inline_message_id;
    return this.ownerOnly && !inlineMode && !allowedUsersOf(ctx) ? ctx.from?.id : undefined;
  }

  /** Storage scope of bot-specific data. */
  private botScope(ctx: Context): string {
    return this.scopeKeysByBot ? String(ctx.me.id) : '';
  }

  /** @internal Show a render result: content, redirect or dialogue start. */
  async present(ctx: C, result: RenderResult, mode: DeliveryMode, depth = 0): Promise<DeliveryResult | undefined> {
    if (!result) return undefined;

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
    const delivery = await deliver(this, ctx, prepared, mode, scope.editTarget, { fallbackToSend: !scope.noFallback });
    if (delivery?.sent.length && ctx.chat) {
      await this.emit('sent', { ctx, chatId: ctx.chat.id, messageIds: delivery.sent, page: scope.view?.id });
    }
    return delivery;
  }

  /** @internal Replace reply-keyboard buttons with the main menu (or remove them), with a short message. */
  async restoreKeyboard(ctx: C, text: string) {
    const markup = this.menu ? this.menu.markup(this.localeOf(ctx), this.textsFor(ctx).closeMenu) : { remove_keyboard: true as const };
    await this.deliverContent(ctx, { text, parseMode: 'plain' }, 'send', markup);
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
      writes.push(this.metaStorage.set(groupKey(bot, chatId, last.message_id), extra, OWNER_TTL_SECONDS));
    }
    if (last.chat.type !== 'private') {
      // Who may press this message's buttons: explicit allowedUsers, or its user.
      const owners = allowedUsersOf(ctx) ?? (this.ownerOnly && ctx.from ? ctx.from.id : undefined);
      if (owners !== undefined) writes.push(this.metaStorage.set(ownerKey(bot, chatId, last.message_id), owners, OWNER_TTL_SECONDS));
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
      // Validation/conversion by `.params(parse)`; a throw rejects the request.
      let parsed: unknown = params;
      if (page.parseFn) {
        try {
          parsed = page.parseFn(params);
        } catch (error) {
          throw error instanceof InvalidParamsError ? error : new InvalidParamsError(`Invalid params for "${page.id}": ${error}`);
        }
      }
      const renderArgs: RenderArgs<any, C> = { ...args, params: parsed, page };
      return page.renderFn!(renderArgs);
    });
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
    const result = await this.guard(ctx, dialogue, params as Params, async () => {
      await this.dialogues.start(ctx, dialogue, params);
      started = true;
      return undefined;
    });
    if (!started) return this.present(ctx, result, options.mode, depth + 1);
    // The dialogue prompt replaces the menu that started it.
    const fromMenu = ctx.callbackQuery && (options.mode === 'edit' || options.mode === 'auto');
    if (options.closeMenu && fromMenu) await this.closeMessage(ctx);
    return undefined;
  }

  private async loadSession(ctx: C): Promise<Session> {
    const key = sessionKey(ctx, this.botScope(ctx));
    if (!key) {
      this.logger.warn('Update has no sender; using a temporary session that is not saved');
      return new Session();
    }
    return new Session(await this.sessionStorage.get(key));
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

    const owner = await this.metaStorage.get(ownerKey(this.botScope(ctx), message.chat.id, message.message_id));
    if (typeof owner === 'number') return owner === userId;
    if (Array.isArray(owner)) return owner.includes(userId);
    if (!this.ownerOnly) return true;

    // Untracked (older) menu: fall back to the user it replied to.
    const repliedTo = (message as Message).reply_to_message?.from;
    if (repliedTo && !repliedTo.is_bot) return repliedTo.id === userId;
    return true;
  }

  private async reportError(error: unknown, ctx: C) {
    if ((await this.emit('error', { error, ctx })) === 0) this.logger.error('Error while handling update', error);
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

/** `bot` is '' when keys aren't scoped by bot (`scopeKeysByBot: false`). */
function scoped(prefix: string, bot: string, ...parts: Array<string | number>) {
  return [prefix, ...(bot ? [bot] : []), ...parts].join(':');
}

function sessionKey(ctx: Context, bot: string): string | null {
  const userId = ctx.from?.id;
  if (userId === undefined) return null;
  return scoped('session', bot, ctx.chat?.id ?? 'global', userId);
}

function ownerKey(bot: string, chatId: number, messageId: number) {
  return scoped('msgowner', bot, chatId, messageId);
}

function groupKey(bot: string, chatId: number, messageId: number) {
  return scoped('msggroup', bot, chatId, messageId);
}

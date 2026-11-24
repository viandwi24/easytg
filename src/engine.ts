// `EasyTG`, the facade of the engine: options, registration and the public
// API. The work is done by the modules in ./engine/, which reach each other
// through the `@internal` members here.
import type { Context, MiddlewareFn, MiddlewareObj, Transformer } from 'grammy';
import type { InlineQueryResult } from 'grammy/types';
import { createThrottle, type ThrottleOptions } from './throttle';
import { normalizeParams, type ParamsInput } from './callback';
import { assertAtomic, type AtomicStorage } from './coordination';
import type { BroadcastResult } from './broadcast';
import type { Dialogue, Page, Task, TaskBot } from './define';
import { DialogueRunner } from './dialogue';
import { Commands, type CommandOptions } from './commands';
import { checkTimeZone } from './steps';
import { FlowRecorder, toMermaid, type FlowEdge, type FlowEdgeKind, type FlowchartOptions } from './flow';
import { RelayStore, relayBotId } from './relay';
import { EasyTGError } from './errors';
import { Scheduler, type ScheduleOptions } from './scheduler';
import type { TextInput } from './format';
import { createConsoleLogger, silentLogger, type Logger } from './logger';
import type { ReplyMenu } from './menu';
import { Nav } from './nav';
import { deepLinkUrl } from './deeplink';
import type { SendTarget } from './proactive';
import type { Delivery as DeliveryOutcome, DeliveryResult, EphemeralSend, SentMessage } from './render';
import type { Session } from './session';
import { MemoryStorage, isTaskStore, withPrefix, type StorageAdapter } from './storage';
import type { EasyTGTexts } from './texts';
import type { Translate } from './i18n';
import type {
  ButtonOptions,
  DeliveryMode,
  LoadingOptions,
  Middleware,
  PageContent,
  Params,
  ParamArgs,
  ParamsArgs,
  ParamsInputOf,
  RenderResult,
  Awaitable,
} from './types';
import type { ReplyKeyboardMarkup, ReplyKeyboardRemove } from 'grammy/types';
import { Buttons } from './engine/buttons';
import { Delivery } from './engine/delivery';
import { Handlers } from './engine/handlers';
import { Loading } from './engine/loading';
import { Locales } from './engine/locale';
import { Pipeline } from './engine/pipeline';
import { Queues } from './engine/queues';
import { Scopes } from './engine/scope';
import { Sending } from './engine/sending';
import { Sessions } from './engine/sessions';
import { Views } from './engine/views';
import type {
  BotLike,
  BroadcastLaterOptions,
  BroadcastOptions,
  DeleteLaterOptions,
  EasyTGEvents,
  EasyTGOptions,
  EditMessageTarget,
  InlineResultOptions,
  OpenOptions,
  RelayApi,
  SendLaterOptions,
  StreamOptions,
  StreamResult,
  StreamSource,
  WithUserArgs,
} from './engine/types';

export type {
  EasyTGOptions,
  PaymentsOptions,
  PaymentArgs,
  SessionOptions,
  MediaOptions,
  ButtonsOptions,
  DeepLinksOptions,
  DialoguesOptions,
  I18nOptions,
  EasyTGEvents,
  StreamSource,
  StreamOptions,
  StreamResult,
  RelayApi,
  RelayOptions,
  DeleteLaterOptions,
  SendLaterOptions,
  WithUserArgs,
  InlineResultOptions,
  UpdateOutcome,
  BroadcastOptions,
  OpenOptions,
  BroadcastLaterOptions,
  EditMessageTarget,
} from './engine/types';

type Registrable<C extends Context> = Page<any, C, any> | Dialogue<any, any, C> | Task<any, C>;

type ScheduleArgs<P> = undefined extends P ? [payload?: P, options?: ScheduleOptions] : [payload: P, options?: ScheduleOptions];

type OpenArgs<P> = {} extends P
  ? [params?: ParamsInputOf<P>, options?: OpenOptions]
  : [params: ParamsInputOf<P>, options?: OpenOptions];

export class EasyTG<C extends Context = Context> implements MiddlewareObj<C> {
  /** @internal */ readonly texts: EasyTGTexts;
  /** @internal */ readonly logger: Logger;
  /** @internal */ readonly homePage: string;
  /** @internal */ readonly cancelDialogueOnCommand: boolean;
  /** @internal */ readonly dialogueTimeoutMs?: number;
  /** @internal */ readonly dialogueTimeZone?: string;
  /** @internal */ readonly mediaToText: 'replace' | 'keep';

  // Registry and shared infrastructure, used by the modules in ./engine/.
  /** @internal */ readonly pages = new Map<string, Page<any, C, any>>();
  /** @internal */ readonly dialogueDefs = new Map<string, Dialogue<any, any, C>>();
  /** @internal */ readonly commands = new Commands<Page<any, any, any> | Dialogue<any, any, any>>();
  /** @internal */ readonly dialogues = new DialogueRunner<C>(this);
  /** @internal */ readonly middlewares: Middleware<C>[];
  /** @internal */ readonly menu?: ReplyMenu<C>;
  /** @internal */ readonly scheduler: Scheduler;
  /** @internal Rate limits, double taps and locks: in memory, or shared with `cluster`. */
  readonly coordination: AtomicStorage;
  /** @internal */ readonly relays: RelayStore;
  /** @internal */ readonly scopes: Scopes;

  // The engine's modules (./engine/).
  /** @internal */ readonly locales: Locales<C>;
  /** @internal */ readonly sessions: Sessions<C>;
  /** @internal */ readonly buttons: Buttons<C>;
  /** @internal */ readonly delivery: Delivery<C>;
  /** @internal */ readonly views: Views<C>;
  /** @internal */ readonly loading: Loading<C>;
  /** @internal */ readonly queues: Queues<C>;
  /** @internal */ readonly sending: Sending<C>;
  /** @internal */ readonly handlers: Handlers<C>;
  /** @internal */ readonly pipeline: Pipeline<C>;

  private readonly listeners = new Map<keyof EasyTGEvents<C>, Set<(event: any) => unknown>>();
  private readonly flow = new FlowRecorder();

  constructor(options: EasyTGOptions<C> = {}) {
    const storage = options.storage ?? new MemoryStorage();
    const scoped = (adapter?: StorageAdapter) => withPrefix(adapter ?? storage, options.keyPrefix ?? '');
    const { session = {}, buttons = {}, deepLinks = {}, dialogues = {}, i18n = {}, media = {} } = options;
    this.logger = options.logger === false ? silentLogger : options.logger ?? createConsoleLogger();
    this.scopes = new Scopes(options.scopeKeysByBot ?? true);

    this.sessions = new Sessions(this, scoped(session.storage), session);
    this.buttons = new Buttons(this, scoped(buttons.storage), buttons, deepLinks);
    this.mediaToText = buttons.mediaToText ?? 'replace';

    this.cancelDialogueOnCommand = dialogues.cancelOnCommand ?? true;
    this.dialogueTimeoutMs = dialogues.timeoutMs;
    checkTimeZone(dialogues.timeZone); // a typo fails at startup, not when a user opens a calendar
    this.dialogueTimeZone = dialogues.timeZone;

    const shared = options.cluster === true ? storage : options.cluster || undefined;
    if (shared) assertAtomic(shared, 'cluster');
    const sharedScoped = shared && (scoped(shared) as AtomicStorage);
    this.coordination = sharedScoped ?? new MemoryStorage();
    this.queues = new Queues(this, options.queues ?? {}, sharedScoped);
    this.pipeline = new Pipeline(this, this.coordination, sharedScoped, options);

    this.scheduler = new Scheduler(
      options.scheduler?.store ?? (isTaskStore(storage) ? storage : undefined),
      this.logger,
      async (event) => {
        if ((await this.emit('taskError', event)) === 0) this.logger.error(`Scheduled task "${event.task.name}" failed`, event.error);
      },
      options.scheduler ?? {},
    );
    this.sending = new Sending(this, options.prepareProactive, options.emitProactiveErrors ?? false);
    this.sending.defineTasks();
    this.handlers = new Handlers(this, options.payments, options.relay?.filter, buttons.doubleTapMs);

    this.locales = new Locales(this, i18n);
    this.texts = this.locales.texts;
    this.relays = new RelayStore(this.sessions.storage);
    // Found by tooling in the same process (`easytg preview` reads flowcharts); weakly held.
    const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for('easytg.apps')] ??= new Set<WeakRef<object>>()) as Set<WeakRef<object>>;
    registry.add(new WeakRef(this));

    this.delivery = new Delivery(this, options.parseMode ?? 'markdown', options.protectContent ?? false, media);
    this.views = new Views(this, options.loading);
    this.loading = new Loading(this);
    this.homePage = options.homePage ?? 'home';
    this.middlewares = options.middlewares ?? [];
    this.menu = options.menu;
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
    const { names, fallbackLocale, translator } = this.locales;
    const languages = this.commands.translated ? [...new Set(names.map((l) => l.split('-')[0]!))] : [];
    for (const language of [undefined, ...languages]) {
      const locale = language ?? fallbackLocale;
      for (const { scope, commands } of this.commands.lists(locale, translator.for(locale))) {
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

  /**
   * The bot's flow as a Mermaid diagram: pages, dialogues, the /commands and
   * menu buttons that open them, and the buttons, redirects and dialogue
   * starts seen while the bot ran in this process (use it, or run your tests
   * or `easytg preview`, first). Paste it into GitHub Markdown or mermaid.live.
   */
  flowchart(options: FlowchartOptions = {}): string {
    const edges: FlowEdge[] = this.commands.list().map((c) => ({ from: `/${c.name}`, to: c.target.id, kind: 'command' }));
    const locale = this.locales.fallbackLocale;
    const t = this.locales.translator.for(locale);
    for (const row of this.menu?.rows ?? []) {
      for (const button of row) {
        if (!('target' in button)) continue;
        const label = typeof button.text === 'function' ? button.text(locale, t) : button.text;
        edges.push({ from: label, to: button.target.id, kind: 'menu' });
      }
    }
    if (options.observed !== false) edges.push(...this.flow.all);
    return toMermaid({ pages: [...this.pages.keys()], dialogues: [...this.dialogueDefs.keys()], edges, direction: options.direction });
  }

  /** @internal A `nav` button, redirect or dialogue start, from the screen being rendered. */
  noteFlow(ctx: C, to: string, kind: FlowEdgeKind, label?: string) {
    const from = this.scopes.get(ctx).flowFrom;
    if (from && (this.pages.has(to) || this.dialogueDefs.has(to))) this.flow.record({ from, to, kind, label });
  }

  /**
   * @internal DeliveryHost: whether this update's new messages go out as
   * ephemeral messages (Bot API 10.2), only for the user who acted. In groups,
   * when asked for (`requested`, or earlier in the update), or when the user
   * acted ephemerally (pressed a button of an ephemeral message, sent an
   * ephemeral command). Telegram lets a bot that isn't an admin send them
   * within 15 seconds of such an action, which `callback_query_id` and the
   * reply to the ephemeral command prove.
   */
  ephemeral(ctx: C, requested: boolean): EphemeralSend | undefined {
    return this.delivery.ephemeral(ctx, requested);
  }

  /** @internal What `nav` calls lead from (a dialogue's onFinish / onCancel). */
  setFlowSource(ctx: C, id: string) {
    this.scopes.get(ctx).flowFrom = id;
  }

  hasPage(id: string) {
    return this.pages.has(id);
  }

  /** @internal */
  findDialogue(id: string) {
    return this.dialogueDefs.get(id);
  }

  /** @internal A registered page, by page or id. */
  page(target: Page<any, any, any> | string): Page<any, C, any> {
    const id = typeof target === 'string' ? target : target.id;
    const page = this.pages.get(id);
    if (!page) throw new EasyTGError(`Page "${id}" is not registered`);
    return page;
  }

  /** @internal A registered dialogue. */
  dialogue(target: Dialogue<any, any, any>): Dialogue<any, any, C> {
    const dialogue = this.dialogueDefs.get(target.id);
    if (!dialogue) throw new EasyTGError(`Dialogue "${target.id}" is not registered`);
    return dialogue;
  }

  // ---- public API ----------------------------------------------------------

  /** Use as `bot.use(app)`, before your other handlers. */
  middleware(): MiddlewareFn<C> {
    return this.pipeline.middleware();
  }

  /** Render a page into the chat (see `DeliveryMode`, default `auto`). */
  open<P>(ctx: C, page: Page<P, any, any>, ...args: OpenArgs<P>): Promise<DeliveryResult | undefined>;
  open(ctx: C, page: string, params?: ParamsInput, options?: OpenOptions): Promise<DeliveryResult | undefined>;
  async open(ctx: C, target: Page<any, any, any> | string, params?: ParamsInput, options: OpenOptions = {}) {
    const page = this.page(target);
    return this.views.show(ctx, page.id, options.mode ?? 'auto', () => this.views.renderPage(ctx, page, normalizeParams(params)));
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
   * Show text while it is being generated (an AI answer), then send it as a
   * message. In private chats the preview is a Telegram draft (Bot API 10:
   * animated, "Thinking…" first, optionally with a stop button); in groups a
   * message that is edited as the text grows. The final message goes out like
   * a page (`finish`: formatting, keyboard; long text is split).
   *
   *   await app.stream(ctx, (signal) => model.stream(prompt, { signal }), { stoppable: true });
   */
  async stream(ctx: C, source: StreamSource, options: StreamOptions = {}): Promise<StreamResult> {
    return this.loading.stream(ctx, source, options);
  }

  /**
   * Run `job` and, if it takes longer than `afterMs`, show loading indicators
   * meanwhile: a repeated chat action ("typing…"), a toast, a placeholder
   * message (deleted when the job is done). For your own slow handlers:
   *
   *   const answer = await app.withLoading(ctx, () => askModel(q), { action: 'typing', text: '⏳ Thinking…' });
   */
  async withLoading<T>(ctx: C, job: () => Awaitable<T>, options: LoadingOptions = { action: 'typing' }): Promise<T> {
    return this.loading.withLoading(ctx, job, options);
  }

  /**
   * @internal Loading for renders: the placeholder is what the page will
   * replace. `fresh`: always a new placeholder message (the pressed message
   * may be gone, e.g. a dialogue prompt).
   */
  async withPlaceholder<T>(ctx: C, options: LoadingOptions, job: () => Awaitable<T>, fresh = false): Promise<T> {
    return this.loading.withPlaceholder(ctx, options, job, fresh);
  }

  /**
   * @internal Show a render result that doesn't come from a page render (a
   * dialogue's onFinish / onCancel, a middleware stopping a dialogue, a
   * payment) the way pages are shown: a redirect is recorded for Back, onText
   * and the `pageView` event.
   */
  showResult(ctx: C, result: RenderResult, mode: DeliveryMode, depth = 0): Promise<DeliveryResult | undefined> {
    return this.views.showResult(ctx, result, mode, depth);
  }

  /** @internal Whether the page being rendered has a page to go back to. */
  canGoBack(ctx: C): boolean {
    return this.views.canGoBack(ctx);
  }

  /**
   * Send a page without an incoming update (notifications, cron jobs,
   * webhooks). `target` is a chat id or `{ chatId, userId?, threadId? }`.
   * The page receives a minimal `ctx`, see `isProactive`.
   */
  sendTo<P>(bot: BotLike, target: number | SendTarget, page: Page<P, any, any>, ...args: ParamArgs<P>): Promise<DeliveryResult | undefined>;
  sendTo(bot: BotLike, target: number | SendTarget, page: string, params?: ParamsInput): Promise<DeliveryResult | undefined>;
  async sendTo(bot: BotLike, target: number | SendTarget, page: Page<any, any, any> | string, params?: ParamsInput) {
    return this.sending.sendTo(bot, target, page, params);
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
    return this.sending.edit(bot, target, page, params);
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
    return this.sending.broadcast(bot, targets, page, options as BroadcastOptions<Params> | undefined);
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
    return this.sending.broadcastLater(targets, page, options as BroadcastLaterOptions<Params> | undefined);
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
    return this.sending.inlineResult(ctx, page, options as InlineResultOptions<Params>);
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
    return this.sending.withUser(bot, target, fn);
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
    const result = await this.sending.renderAsInline(bot, options.userId, page, options as InlineResultOptions<Params>);
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
    const result = await this.sending.renderAsInline(bot, userId, page, options as InlineResultOptions<Params>);
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

  /** Start a dialogue for the user of `ctx` (middlewares run first). */
  startDialogue<P>(ctx: C, dialogue: Dialogue<any, P, any>, ...args: ParamArgs<P>): Promise<void>;
  async startDialogue(ctx: C, dialogue: Dialogue<any, any, any>, params?: ParamsInput) {
    await this.views.guardedDialogueStart(ctx, this.dialogue(dialogue), normalizeParams(params), { mode: 'auto', closeMenu: false });
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

  /** @internal Whether anyone listens to `event` (to skip building costly payloads). */
  hasListeners(event: keyof EasyTGEvents<C>): boolean {
    return !!this.listeners.get(event)?.size;
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
    return this.sending.deleteLater(target, messageIds, options);
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
    return this.sending.sendLater(target, page, options);
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

  // ---- queues --------------------------------------------------------------

  /**
   * Run `job` within the concurrency limit of a queue (see the `queues`
   * option), waiting for a free slot first. Pass `ctx` for `perUser` limits
   * and the `queueWait` event. Throws `QueueFullError` / `QueueTimeoutError`.
   *
   *   const answer = await app.queue('ai', () => askModel(prompt), { ctx });
   */
  async queue<T>(name: string, job: () => Awaitable<T>, options: { ctx?: C } = {}): Promise<T> {
    return this.queues.run(name, job, options.ctx);
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
    return this.queues.enter(ctx, name);
  }

  /**
   * Ignore all updates from a user for `ms`, on one bot or (without `botId`)
   * on every bot. Works even with `antiSpam: false`.
   */
  limitUser(userId: number, ms: number, botId?: number): Promise<void> {
    return this.pipeline.spamGuard.block(userId, botId === undefined ? '*' : String(botId), ms);
  }

  /** Lift limits set by anti-spam or `limitUser`: on one bot (and the every-bot limit), or all. */
  releaseUser(userId: number, botId?: number): Promise<void> {
    return this.pipeline.spamGuard.release(userId, botId);
  }

  /** Whether a user is limited on a bot, or (without `botId`) on any bot. */
  isLimited(userId: number, botId?: number): Promise<boolean> {
    return this.pipeline.spamGuard.isBlocked(userId, botId);
  }

  /** Send `text` with the main menu (the `menu` option) on the reply keyboard. */
  async showMenu(ctx: C, text: TextInput) {
    if (!this.menu) throw new EasyTGError('No menu configured: pass `menu: replyMenu([...])` to new EasyTG()');
    const result = await this.delivery.deliverContent(ctx, { text }, 'send', this.menu.markup(this.localeOf(ctx), this.textsFor(ctx).closeMenu, this.t(ctx)));
    await this.flush(ctx);
    return result?.result;
  }

  /** Send `text` and remove the reply keyboard. */
  async hideMenu(ctx: C, text: TextInput) {
    const result = await this.delivery.deliverContent(ctx, { text }, 'send', { remove_keyboard: true });
    await this.flush(ctx);
    return result?.result;
  }

  /** The session of the user in `ctx`. Loaded once per update. */
  session(ctx: C): Promise<Session> {
    return this.sessions.state(ctx);
  }

  /**
   * @internal The session of the user in this chat, where easytg keeps its own
   * state (dialogues, navigation, text input). Same as `session(ctx)`.
   * Loading it also resolves the user's language.
   */
  state(ctx: C): Promise<Session> {
    return this.sessions.state(ctx);
  }

  /**
   * The user's session across all chats (private chat, groups), next to the
   * per-chat `session`: for what belongs to the person, like a plan, a cart
   * or settings. Loaded once per update and saved with it; changes made by
   * the user's updates in other chats at the same time are merged per key.
   */
  userSession(ctx: C): Promise<Session> {
    return this.sessions.user(ctx);
  }

  /** @internal The session, once `session(ctx)` has been awaited. */
  loadedSession(ctx: C): Session {
    return this.sessions.loaded(ctx);
  }

  /** The user's language: the `locale` option once the session is loaded, else `language_code`. */
  localeOf(ctx: C): string | undefined {
    return this.locales.localeOf(ctx);
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
    return this.locales.t(ctx);
  }

  /**
   * Set the user's language (e.g. from a language picker), or `undefined` to
   * follow their Telegram app again. It is kept in the user session, so it
   * applies in every chat, to the rest of this update at once (`t`, built-in
   * texts), and to messages sent to them later (`sendTo`, `sendLater`,
   * `broadcast`). It wins over `i18n.locale`.
   */
  async setLocale(ctx: C, locale: string | undefined): Promise<void> {
    return this.sessions.setLocale(ctx, locale);
  }

  /** Built-in texts in the user's language. */
  textsFor(ctx: C): EasyTGTexts {
    return this.locales.textsFor(ctx);
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
    const { payload, stored } = this.buttons.deepLinkPayload(target.id, params, options);
    if (stored) await this.buttons.deepLinks.write(stored.token, stored.entry);
    return deepLinkUrl(username, payload);
  }

  /** A `Nav` for keyboards built outside renders. Stored buttons are saved when the update finishes (or on `flush`). */
  nav(ctx: C): Nav<C> {
    return new Nav(this, ctx);
  }

  /** Save pending session changes and stored buttons now. */
  async flush(ctx: C) {
    const scope = this.scopes.peek(ctx);
    if (!scope) return;
    await this.buttons.flush(scope);
    await this.sessions.save(ctx, scope);
  }

  // ---- internals used by Nav / DialogueRunner / render ----------------------

  /** @internal Callback data for a registered page/dialogue. */
  callbackData(ctx: C, id: string, params?: ParamsInput, options?: ButtonOptions): string {
    return this.buttons.callbackData(ctx, id, params, options);
  }

  /** @internal Deep link URL, used by `nav.deepLink` (stored params are saved with the render). */
  deepLinkFor(ctx: C, id: string, params?: ParamsInput, options?: ButtonOptions): string {
    const { payload, stored } = this.buttons.deepLinkPayload(id, params, options);
    if (stored) this.scopes.get(ctx).pendingLinks.set(stored.token, stored.entry);
    return deepLinkUrl(ctx.me.username, payload);
  }

  /** @internal Callback data for dialogue controls (checked against dialogue state, so inline is fine). */
  controlData(ctx: C, params: ParamsInput): string {
    return this.buttons.controlData(ctx, params);
  }

  /** @internal Show a render result: content, redirect or dialogue start. */
  async present(ctx: C, result: RenderResult, mode: DeliveryMode, depth = 0): Promise<DeliveryResult | undefined> {
    return this.views.present(ctx, result, mode, depth);
  }

  /** @internal Send/edit content; stored buttons are persisted before the message goes out. */
  async deliverContent(
    ctx: C,
    content: PageContent,
    mode: DeliveryMode,
    sendMarkup?: ReplyKeyboardMarkup | ReplyKeyboardRemove,
  ): Promise<DeliveryOutcome | undefined> {
    return this.delivery.deliverContent(ctx, content, mode, sendMarkup);
  }

  /** @internal Replace reply-keyboard buttons with the main menu (or remove them), with a short message. */
  async restoreKeyboard(ctx: C, text: string) {
    await this.delivery.restoreKeyboard(ctx, text);
  }

  /**
   * Answer the button press now, e.g. with "Working on it…" before something
   * slow, so the button's spinner stops. easytg then doesn't answer again (a
   * `toast` from the render is dropped). No-op outside button presses.
   */
  async answer(ctx: C, toast?: string | { text: string; alert?: boolean }): Promise<void> {
    const options = typeof toast === 'string' ? { text: toast } : toast && { text: toast.text, show_alert: toast.alert };
    await this.delivery.answerCallback(ctx, options);
  }

  /** @internal Answer the current callback query once; later calls are no-ops. */
  async answerCallback(ctx: C, options?: { text?: string; show_alert?: boolean }) {
    await this.delivery.answerCallback(ctx, options);
  }

  /** @internal Delete the pressed message; if it's too old to delete, strip its keyboard. */
  async closeMessage(ctx: C) {
    await this.delivery.closeMessage(ctx);
  }

  /** @internal Remember who a group menu belongs to, and which messages a long page was split into. */
  async onSent(ctx: Context, messages: SentMessage[]) {
    await this.buttons.onSent(ctx, messages);
  }

  /** @internal */
  async takeGroup(ctx: Context, chatId: number, messageId: number): Promise<number[]> {
    return this.buttons.takeGroup(ctx, chatId, messageId);
  }

  /**
   * State shared by everyone in the chat (a group's settings, a game board),
   * next to each user's own `session`. Loaded once per update and saved with
   * it. Updates of different users can run at the same time, so for counters
   * that many users change at once, prefer an atomic store.
   */
  chatSession(ctx: C): Promise<Session> {
    return this.sessions.chat(ctx);
  }
}

/**
 * A Telegram simulator: an in-memory Bot API that a real grammY bot talks
 * to, plus simulated users who send messages, press buttons, pay invoices and
 * use inline mode. Nothing leaves the process, so it runs in browsers too
 * (the docs playgrounds), in tests, and in a local preview.
 *
 *   import { Bot } from 'grammy';
 *   import { TelegramSimulator } from 'easytg/simulator';
 *
 *   const sim = new TelegramSimulator();
 *   const bot = new Bot(sim.token);
 *   sim.connect(bot);          // or sim.createBot()
 *   bot.use(app);
 *   await sim.send('/start');  // as the default user, in their private chat
 *   sim.messages();            // what the chat shows now
 *
 * The simulator answers like Telegram, errors included ("message is not
 * modified", "can't parse entities", "bot was blocked by the user", …), so
 * what works here works against Telegram too. `bot.start()` works as well:
 * updates then go out through `getUpdates` instead of `bot.handleUpdate`.
 */
import { Bot, type BotConfig, type Context } from 'grammy';
import type {
  BotCommand,
  Chat,
  ChatMember,
  ForceReply,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  InlineQueryResult,
  KeyboardButton,
  Message,
  MessageEntity,
  ReplyKeyboardMarkup,
  RichBlock,
  RichMessage,
  RichMessageButton,
  Update,
  User,
  UserFromGetMe,
} from 'grammy/types';
import { ParseError, parseFormatted } from './entities';
import { parseRichMessage, plainOf, RichMessageError, richButtons, richPlainText, type RichMediaKind } from './rich';
import { visibleTo } from './visibility';

export { parseFormatted, parseHtml, parseMarkdownV2, ParseError } from './entities';
export { richButtons, richHtml, richPlainText, type RichHtmlOptions } from './rich';
export { visibleTo } from './visibility';

/** What a message says as plain text: its text, its caption, or a rich message's text. */
export function messageText(message: Message): string | undefined {
  return message.text ?? message.caption ?? (message.rich_message ? richPlainText(message.rich_message) : undefined);
}

export type SimUser = User;

export type SimMediaKind = 'photo' | 'video' | 'animation' | 'audio' | 'document' | 'voice' | 'sticker' | 'video_note';

export interface SimMedia {
  kind: SimMediaKind;
  /** Something a browser can show (http(s), data: or blob: URL), when the bot sent one. */
  url?: string;
  /** File name, for documents and audio. */
  name?: string;
}

export interface SimMessage {
  /** The message as the Bot API describes it (text, entities, reply_markup, …). */
  message: Message;
  /** Sent by the bot (messages users send "via @bot" in inline mode are theirs). */
  fromBot: boolean;
  media?: SimMedia;
  /** Set for messages sent through inline mode that can be edited. */
  inlineMessageId?: string;
  /** A note shown in the chat that isn't a Telegram message ("Bot restarted"); the bot never sees it. */
  notice?: string;
  /** An ephemeral message (Bot API 10.2): only this user sees it (and the bot). */
  receiver?: number;
  /** Users who see an ephemeral message in this message's place. */
  hiddenFor?: number[];
  /** For an ephemeral message shown in place of another: that message's id. */
  replaced?: number;
}

export interface SimMember {
  user: User;
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  /** Rights of an administrator (all true unless given), or permissions of a restricted member. */
  rights: Record<string, boolean>;
  until?: number;
}

export interface SimChat {
  id: number;
  type: Chat['type'];
  title?: string;
  /** For private chats: the user. */
  user?: User;
  members: Map<number, SimMember>;
  messages: SimMessage[];
  /** The reply keyboard the bot showed last (null when removed). */
  replyKeyboard: ReplyKeyboardMarkup | null;
  /** The user closed a one-time keyboard; it can be opened again. */
  replyKeyboardHidden: boolean;
  forceReply: ForceReply | null;
  /** "typing…", "sending photo…": set by sendChatAction, cleared by the next message or after 5 s. */
  action: { action: string; until: number } | null;
  pinned: number[];
  /** Private chats: the user started the bot (bots can't start conversations). */
  started: boolean;
  /** Private chats: the user blocked the bot. */
  blocked: boolean;
  /**
   * A message being generated (`sendMessageDraft`, Bot API 10): shown until
   * the bot sends a message or 30 s pass. `canStop`: with a stop button.
   */
  draft: { id: number; text: string; canStop: boolean; until: number; rich?: RichMessage } | null;
}

export interface SimCallbackAnswer {
  text?: string;
  alert?: boolean;
  url?: string;
}

export interface SimApiCall {
  method: string;
  payload: Record<string, any>;
  result?: unknown;
  error?: string;
  at: number;
}

export interface SimEvents {
  /** Anything visible changed: messages, keyboards, chat actions, members. */
  change: { chatId?: number };
  /** The bot answered a button press with a text (a toast or an alert). */
  toast: { chatId?: number; userId: number; text: string; alert: boolean };
  /** A button asked to open a URL (url buttons, `answerCallbackQuery({ url })`, Mini Apps). */
  open: { url: string; kind: 'url' | 'webApp' | 'login' | 'game'; chatId?: number; userId: number };
  /** Every Bot API call and its result, in order. */
  call: SimApiCall;
  /** A handler threw (the bot has no `bot.catch`), or delivering an update failed. */
  error: { error: unknown };
}

export interface SimulatorOptions {
  /** The bot's identity. */
  bot?: Partial<UserFromGetMe>;
  /** The first simulated user (more with `addUser`). */
  user?: Partial<User>;
  /** Delay every API call by this much, to see loading indicators. Default 0. */
  latencyMs?: number;
  /** Keep this many API calls in `calls`. Default 200. */
  callLog?: number;
  /**
   * Where uploaded files go, for chat windows to show them: returns a URL.
   * Default: an object URL (in browsers). `easytg preview` serves them itself.
   */
  storeFile?: (data: Blob, name?: string) => string | undefined;
  /**
   * Answer too many messages with Telegram's `429 Too Many Requests: retry
   * after N`, to try `app.throttle` and `autoRetry`. `true`: Telegram's
   * advised limits (30 per second overall, 20 per minute per group); or your
   * own. Counts sending, copying, forwarding and editing, an album as one per
   * item. Default: no limits.
   */
  rateLimits?: boolean | SimRateLimits;
}

export interface SimRateLimit {
  limit: number;
  perMs: number;
}

export interface SimRateLimits {
  global?: SimRateLimit | false;
  groupChat?: SimRateLimit | false;
  privateChat?: SimRateLimit | false;
}

const TELEGRAM_LIMITS: SimRateLimits = { global: { limit: 30, perMs: 1000 }, groupChat: { limit: 20, perMs: 60_000 }, privateChat: false };
const RATE_LIMITED = /^(send(?!ChatAction|MessageDraft|RichMessageDraft)|copyMessage|forwardMessage|editMessage)/;
/** The methods that take `ephemeral_message_parameters` (Bot API 10.3). */
const EPHEMERAL_METHODS = new Set([
  'sendMessage',
  'sendAnimation',
  'sendAudio',
  'sendDocument',
  'sendLivePhoto',
  'sendPhoto',
  'sendSticker',
  'sendVideo',
  'sendVideoNote',
  'sendVoice',
  'sendContact',
  'sendLocation',
  'sendVenue',
  'sendRichMessage',
]);

export interface SendOptions {
  /** The user sending; default: the first user. */
  user?: number;
  /** The chat; default: the user's private chat. */
  chat?: number;
  /** Reply to this message id. */
  replyTo?: number;
  /**
   * In a group, send it ephemerally: only the bot sees it (Bot API 10.2).
   * A command the bot lists with `is_ephemeral` is sent like that by itself.
   */
  ephemeral?: boolean;
}

type Listener<T> = (event: T) => void;
type ApiResult = { ok: true; result: unknown } | { ok: false; error_code: number; description: string; parameters?: object };

const MESSAGE_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const NOT_MODIFIED =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';
const MEDIA_KINDS: SimMediaKind[] = ['photo', 'video', 'animation', 'audio', 'document', 'voice', 'sticker', 'video_note'];

class ApiError extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly parameters?: object,
  ) {
    super(description);
  }
}

const badRequest = (description: string) => new ApiError(400, `Bad Request: ${description}`);
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class TelegramSimulator {
  readonly botInfo: UserFromGetMe;
  /** A token for `new Bot(sim.token)`; the simulator never checks it. */
  readonly token: string;
  readonly users = new Map<number, User>();
  readonly chats = new Map<number, SimChat>();
  /** Recent Bot API calls, oldest first. */
  readonly calls: SimApiCall[] = [];
  /** Command lists from `setMyCommands`, by scope and language. */
  private readonly commandLists = new Map<string, BotCommand[]>();
  latencyMs: number;

  private bot?: Bot<any>;
  private readonly listeners = new Map<keyof SimEvents, Set<Listener<any>>>();
  private readonly callLimit: number;
  private updateId = 1;
  private nextFile = 1;
  private nextQuery = 1;
  private nextGroup = 1;
  private readonly files = new Map<string, SimMedia>();
  /** File contents by file id, for downloads (`getFile` + `/file/bot…/path`). */
  private readonly fileData = new Map<string, Blob>();
  private readonly mediaData = new WeakMap<SimMedia, Blob>();
  private readonly storeFile?: (data: Blob, name?: string) => string | undefined;
  private polled = false;
  private readonly rateLimits?: SimRateLimits;
  /** Calls counted per rate-limit key in its current window, for `rateLimits`. */
  private readonly sendLog = new Map<string, { window: number; count: number }>();
  private pollWaiters: (() => void)[] = [];
  private nextNotice = 1;
  private readonly messageIds = new Map<number, number>();
  private readonly callbackQueries = new Map<string, { answer?: SimCallbackAnswer; chatId?: number; userId: number; at: number; message?: SimMessage }>();
  /** Ephemeral messages users sent (ephemeral commands), which the bot may answer ephemerally for 15 s. */
  private readonly incomingEphemeral = new Map<string, { userId: number; at: number }>();
  private readonly ephemeralIds = new Map<number, number>();
  private readonly inlineQueries = new Map<string, (results: InlineQueryResult[] | null) => void>();
  private readonly preCheckouts = new Map<string, (answer: { ok: boolean; error?: string }) => void>();
  private readonly queue: Update[] = [];
  private waiting: (() => void) | null = null;
  /** Updates handed out through getUpdates, until the bot confirms them (a later getUpdates offset). */
  private readonly unconfirmed: { updateId: number; done: () => void }[] = [];
  private readonly actionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(options: SimulatorOptions = {}) {
    this.botInfo = {
      id: 7000000001,
      is_bot: true,
      first_name: 'Demo Bot',
      username: 'demo_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: true,
      can_connect_to_business: false,
      has_main_web_app: false,
      ...options.bot,
    } as UserFromGetMe;
    this.token = `${this.botInfo.id}:SIMULATOR`;
    this.latencyMs = options.latencyMs ?? 0;
    this.callLimit = options.callLog ?? 200;
    this.storeFile = options.storeFile;
    this.rateLimits = options.rateLimits === true ? TELEGRAM_LIMITS : options.rateLimits || undefined;
    this.addUser({ id: 1001, first_name: 'You', language_code: 'en', ...options.user });
  }

  /* ------------------------------ setup ------------------------------ */

  /** Route the bot's API calls to the simulator. Call once, before `bot.use(...)` is fine too. */
  connect(bot: Bot<any>): this {
    if (this.bot) throw new Error('This simulator is already connected to a bot');
    this.bot = bot;
    bot.api.config.use((_prev, method, payload, signal) => this.call(method, (payload ?? {}) as Record<string, any>, signal as AbortSignal | undefined) as never);
    return this;
  }

  /** A grammY bot connected to this simulator. */
  createBot<C extends Context = Context>(config: BotConfig<C> = {}): Bot<C> {
    const bot = new Bot<C>(this.token, { ...config, botInfo: this.botInfo });
    this.connect(bot);
    return bot;
  }

  addUser(user: Partial<User> & { first_name: string }): User {
    const id = user.id ?? Math.max(1000, ...this.users.keys()) + 1;
    const full: User = { is_bot: false, ...user, id };
    this.users.set(id, full);
    return full;
  }

  /** The first user: the one acting when no `user` is given. */
  get user(): User {
    return this.users.values().next().value!;
  }

  /** A group (a supergroup, like most groups today) with these members; the first user creates it and the bot is an admin. */
  createGroup(options: { title: string; members?: number[]; admins?: number[]; id?: number; type?: 'group' | 'supergroup'; /** The bot is an admin (default true). */ botAdmin?: boolean }): SimChat {
    const id = options.id ?? -(1_000_000_000_000 + this.nextGroup++);
    const members = options.members ?? [this.user.id];
    const chat = this.newChat(id, options.type ?? 'supergroup', { title: options.title });
    members.forEach((userId, index) => {
      const status = index === 0 ? 'creator' : options.admins?.includes(userId) ? 'administrator' : 'member';
      chat.members.set(userId, { user: this.userOf(userId), status, rights: {} });
    });
    chat.members.set(this.botInfo.id, { user: this.botUser(), status: options.botAdmin === false ? 'member' : 'administrator', rights: {} });
    this.emit('change', { chatId: id });
    return chat;
  }

  /** The private chat of a user with the bot. */
  privateChat(userId = this.user.id): SimChat {
    const existing = this.chats.get(userId);
    if (existing) return existing;
    const user = this.userOf(userId);
    const chat = this.newChat(userId, 'private', { user });
    chat.members.set(userId, { user, status: 'member', rights: {} });
    return chat;
  }

  chat(id: number): SimChat | undefined {
    return this.chats.get(id);
  }

  /** The messages of a chat, oldest first (default: the first user's private chat). */
  messages(chatId = this.user.id, as?: number): SimMessage[] {
    return visibleTo(this.chats.get(chatId)?.messages ?? [], as);
  }

  /** The last message in a chat; with `as`, the last one that user sees (ephemeral messages are per user). */
  last(chatId = this.user.id, as?: number): SimMessage | undefined {
    return this.messages(chatId, as).at(-1);
  }

  /** The commands of the default list (all chats, no language). */
  get commands(): BotCommand[] {
    return this.commandLists.get('default|') ?? [];
  }

  /**
   * The command menu a user sees in a chat, picked like Telegram does: the
   * most specific scope with a list (the chat, its admins, private chats or
   * groups, then the default), in the user's language if there is a list
   * for it.
   */
  commandsFor(chatId = this.user.id, userId = this.user.id): BotCommand[] {
    const chat = this.chats.get(chatId);
    const language = this.users.get(userId)?.language_code?.split('-')[0] ?? '';
    const status = chat?.members.get(userId)?.status;
    const admin = status === 'creator' || status === 'administrator';
    const scopes =
      !chat || chat.type === 'private'
        ? [`chat:${chatId}`, 'all_private_chats', 'default']
        : [`chat_member:${chatId}:${userId}`, ...(admin ? [`chat_administrators:${chatId}`] : []), `chat:${chatId}`, ...(admin ? ['all_chat_administrators'] : []), 'all_group_chats', 'default'];
    for (const scope of scopes) {
      const list = this.commandLists.get(`${scope}|${language}`) ?? this.commandLists.get(`${scope}|`);
      if (list) return list;
    }
    return [];
  }

  /** Forget all chats and messages (users, commands and the bot stay). */
  /**
   * "Clear history", like in Telegram: the chat is emptied for everyone
   * watching the simulator, and the bot isn't told. Buttons of cleared
   * messages can't be pressed any more; reply keyboards go with them.
   */
  clearHistory(chatId = this.user.id) {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    chat.messages = [];
    chat.replyKeyboard = null;
    chat.replyKeyboardHidden = false;
    chat.forceReply = null;
    chat.pinned = [];
    this.emit('change', { chatId });
  }

  reset() {
    this.chats.clear();
    this.messageIds.clear();
    this.calls.length = 0;
    this.emit('change', {});
  }

  on<K extends keyof SimEvents>(event: K, listener: Listener<SimEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  /**
   * Resolves once a bot polls for updates (`bot.start()`, or a bot in another
   * process). Rejects after `timeoutMs`.
   */
  waitForPolling(timeoutMs = 5000): Promise<void> {
    if (this.polled) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No bot polled for updates within ${timeoutMs} ms`)), timeoutMs);
      this.pollWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** A note in the chat that isn't a message ("🔄 Bot restarted"); the bot never sees it. Default: every chat. */
  notice(text: string, chatId?: number) {
    for (const chat of chatId === undefined ? this.chats.values() : [this.chatFor(chatId)]) {
      const message = { message_id: -this.nextNotice++, date: now(), chat: this.chatObject(chat) } as Message;
      chat.messages.push({ message, fromBot: false, notice: text });
      this.emit('change', { chatId: chat.id });
    }
  }

  /**
   * A user presses the button labelled `label`: the newest inline button with
   * that text in the chat, else a reply-keyboard button. Handy in tests:
   *
   *   await sim.tap('🛍 Products');
   */
  async tap(label: string, options: SendOptions = {}): Promise<SimCallbackAnswer | SimMessage | undefined> {
    const userId = options.user ?? this.user.id;
    const chat = this.chatFor(options.chat ?? userId);
    for (const item of [...visibleTo(chat.messages, userId)].reverse()) {
      const rows = item.message.reply_markup?.inline_keyboard ?? [];
      const rich = richButtons(item.message.rich_message).map((b) => ({ ...b, text: plainOf(b.text) }) as InlineKeyboardButton);
      // A greyed-out button with the same label (a day out of range) is never the one meant.
      const button = [...rows.flat(), ...rich].find((b) => b.text === label && !('disabled' in b && b.disabled));
      if (button) return this.press(item.message.message_id, button, { user: userId, chat: chat.id, inlineMessageId: item.inlineMessageId });
    }
    const reply = chat.replyKeyboard?.keyboard.flat().find((b) => (typeof b === 'string' ? b : b.text) === label);
    if (reply) return this.pressReply(reply, { ...options, user: userId, chat: chat.id });
    throw new Error(`No button "${label}" in chat ${chat.title ?? chat.id}`);
  }

  /**
   * The Bot API over HTTP, as a fetch handler: `POST /bot<token>/<method>`
   * (JSON, form or multipart with files) and file downloads
   * (`/file/bot<token>/<file_path>`). Serve it, and point a bot in another
   * process at it (`new Bot(token, { client: { apiRoot } })`); `easytg
   * preview` does.
   */
  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const download = /\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
    if (download) {
      const id = decodeURIComponent(download[1]!).split('/').pop()!;
      const data = this.fileData.get(id);
      if (data) return new Response(data);
      const remote = this.files.get(id)?.url;
      return remote && /^https?:/.test(remote) ? Response.redirect(remote, 302) : new Response('Not Found', { status: 404 });
    }
    const call = /\/bot[^/]+\/(\w+)$/.exec(url.pathname);
    if (!call) return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 });
    let payload: Record<string, any>;
    try {
      payload = await readPayload(request, url);
    } catch {
      return Response.json({ ok: false, error_code: 400, description: 'Bad Request: invalid request body' }, { status: 400 });
    }
    const result = await this.call(call[1]!, payload, request.signal);
    return Response.json(result, { status: result.ok ? 200 : result.error_code });
  }

  /* ---------------------------- user actions ---------------------------- */

  /** A user sends a text message. Resolves when the bot has handled it (unless the bot polls with `bot.start()`). */
  async send(text: string, options: SendOptions = {}): Promise<SimMessage> {
    if (!text) throw new Error('Empty message');
    const formatted = parseFormatted(text, undefined, undefined);
    // A command the bot declared ephemeral goes out ephemerally in groups, as Telegram apps send it.
    const chat = options.chat === undefined ? undefined : this.chats.get(options.chat);
    if (options.ephemeral === undefined && chat && chat.type !== 'private' && formatted.entities[0]?.type === 'bot_command' && formatted.entities[0].offset === 0) {
      const name = text.slice(1, formatted.entities[0].length).split('@')[0];
      if (this.commandsFor(chat.id, options.user ?? this.user.id).some((c) => c.command === name && (c as BotCommand & { is_ephemeral?: boolean }).is_ephemeral)) {
        options = { ...options, ephemeral: true };
      }
    }
    return this.userMessage({ text, entities: formatted.entities.length ? formatted.entities : undefined }, options);
  }

  /** A user sends a photo (any URL a browser can show) or a document. */
  async sendMedia(kind: SimMediaKind, source: { url?: string; data?: Blob; name?: string; caption?: string }, options: SendOptions = {}) {
    const stored = source.data ? this.mediaFrom(kind, source.data, source.name) : { kind, url: source.url, name: source.name };
    const fileId = this.registerFile(stored);
    const file = { file_id: fileId, file_unique_id: fileId, file_size: 1024 };
    const media =
      kind === 'photo'
        ? { photo: [{ ...file, width: 800, height: 600 }] }
        : { [kind]: { ...file, file_name: source.name, ...(kind === 'video' || kind === 'animation' ? { width: 640, height: 360, duration: 5 } : {}) } };
    return this.userMessage({ ...media, caption: source.caption }, options, stored);
  }

  async sendLocation(latitude: number, longitude: number, options: SendOptions = {}) {
    return this.userMessage({ location: { latitude, longitude } }, options);
  }

  /** A user shares a contact (their own by default, like a `request_contact` button). */
  async sendContact(contact: { phone_number: string; first_name?: string; user_id?: number } | undefined, options: SendOptions = {}) {
    const user = this.userOf(options.user ?? this.user.id);
    return this.userMessage({ contact: { first_name: user.first_name, user_id: user.id, phone_number: '+10000000000', ...contact } }, options);
  }

  /** What a Mini App opened from a reply-keyboard button sends with `Telegram.WebApp.sendData`. */
  async sendWebAppData(data: string, buttonText: string, options: SendOptions = {}) {
    return this.userMessage({ web_app_data: { data, button_text: buttonText } }, options);
  }

  /**
   * A user presses an inline button of a message: `button` is its text, its
   * callback data, `[row, column]` or the button itself. Resolves with the
   * bot's answer (toast, alert or URL) once the bot has handled the press.
   */
  async press(
    messageId: number,
    button: string | [number, number] | InlineKeyboardButton | RichMessageButton,
    options: { user?: number; chat?: number; inlineMessageId?: string } = {},
  ): Promise<SimCallbackAnswer> {
    const userId = options.user ?? this.user.id;
    const found = options.inlineMessageId ? this.findInline(options.inlineMessageId) : this.findMessage(options.chat ?? userId, messageId);
    if (!found) throw new Error(`No message ${messageId} in chat ${options.chat ?? userId}`);
    const rows = (found.message.reply_markup as InlineKeyboardMarkup | undefined)?.inline_keyboard ?? [];
    // Buttons of a rich message (inside its text) can be pressed too; their label is rich text.
    const rich = richButtons(found.message.rich_message).map((b) => ({ ...b, text: plainOf(b.text) }) as InlineKeyboardButton);
    const target: InlineKeyboardButton | undefined =
      typeof button === 'object' && !Array.isArray(button)
        ? ({ ...button, text: plainOf(button.text) } as InlineKeyboardButton)
        : Array.isArray(button)
          ? rows[button[0]]?.[button[1]]
          : [...rows.flat(), ...rich].find((b) => ('callback_data' in b && b.callback_data === button) || b.text === button);
    if (!target) throw new Error(`No button ${JSON.stringify(button)} on message ${messageId}`);
    const chatId = found.message.chat.id;

    if ('disabled' in target && target.disabled) return {}; // greyed out: Telegram sends nothing
    if ('url' in target && target.url) return this.open(target.url, 'url', chatId, userId);
    if ('web_app' in target && target.web_app) return this.open(target.web_app.url, 'webApp', chatId, userId);
    if ('login_url' in target && target.login_url) return this.open(target.login_url.url, 'login', chatId, userId);
    if ('pay' in target && target.pay) return (await this.pay(found.message.message_id, { user: userId, chat: chatId }), {});
    if ('copy_text' in target && target.copy_text) return { text: 'Copied to clipboard' };
    if (!('callback_data' in target) || target.callback_data === undefined) return {};

    const id = String(this.nextQuery++);
    if (!visibleTo([found], userId).length) throw new Error(`User ${userId} doesn't see message ${messageId}`);
    const query = { chatId, userId, answer: undefined as SimCallbackAnswer | undefined, at: Date.now(), message: found };
    this.callbackQueries.set(id, query);
    const inline = found.inlineMessageId && options.inlineMessageId;
    await this.deliver({
      callback_query: {
        id,
        from: this.userOf(userId),
        chat_instance: String(chatId),
        data: target.callback_data,
        ...(inline ? { inline_message_id: found.inlineMessageId } : { message: found.message }),
      },
    } as Omit<Update, 'update_id'>);
    return query.answer ?? {};
  }

  /** A user presses a reply-keyboard button (text, contact, location or Mini App requests). */
  async pressReply(button: KeyboardButton | string, options: SendOptions = {}): Promise<SimMessage | undefined> {
    const chat = this.chats.get(options.chat ?? options.user ?? this.user.id);
    if (chat?.replyKeyboard?.one_time_keyboard) {
      chat.replyKeyboardHidden = true;
      this.emit('change', { chatId: chat.id });
    }
    if (typeof button === 'string') return this.send(button, options);
    if ('request_contact' in button && button.request_contact) return this.sendContact(undefined, options);
    if ('request_location' in button && button.request_location) return this.sendLocation(-6.2, 106.816666, options);
    if ('web_app' in button && button.web_app) {
      this.open(button.web_app.url, 'webApp', chat?.id, options.user ?? this.user.id);
      return undefined;
    }
    return this.send(button.text, options);
  }

  /** A user edits one of their messages. */
  async editMessage(messageId: number, text: string, options: SendOptions = {}): Promise<SimMessage> {
    const userId = options.user ?? this.user.id;
    const found = this.findMessage(options.chat ?? userId, messageId);
    if (!found || found.fromBot) throw new Error(`No message ${messageId} of the user`);
    const formatted = parseFormatted(text, undefined, undefined);
    found.message = { ...found.message, text, entities: formatted.entities.length ? formatted.entities : undefined, edit_date: now() } as Message;
    this.emit('change', { chatId: found.message.chat.id });
    await this.deliver({ edited_message: found.message } as Omit<Update, 'update_id'>);
    return found;
  }

  /**
   * A user types `@bot query`: resolves with the bot's results (an empty
   * list when it answers none).
   */
  async inlineQuery(query: string, options: { user?: number; chatType?: 'sender' | 'private' | 'group' | 'supergroup'; offset?: string } = {}) {
    const id = String(this.nextQuery++);
    const answered = new Promise<InlineQueryResult[] | null>((resolve) => this.inlineQueries.set(id, resolve));
    await this.deliver({
      inline_query: { id, from: this.userOf(options.user ?? this.user.id), query, offset: options.offset ?? '', chat_type: options.chatType ?? 'private' },
    } as Omit<Update, 'update_id'>);
    // Answered while it was handled; if not, there are no results.
    const results = await Promise.race([answered, Promise.resolve(null)]);
    this.inlineQueries.delete(id);
    return results ?? [];
  }

  /** A user picks an inline result: it's sent to the chat as their message, "via @bot". */
  async chooseInlineResult(result: InlineQueryResult, query: string, options: SendOptions = {}): Promise<SimMessage> {
    const userId = options.user ?? this.user.id;
    const chat = this.chatFor(options.chat ?? userId);
    const r = result as InlineQueryResult & Record<string, any>;
    const content = r.input_message_content as Record<string, any> | undefined;
    let fields: Partial<Message> = {};
    let media: SimMedia | undefined;
    if (content?.message_text !== undefined) {
      const formatted = this.format(content.message_text, content.parse_mode, content.entities, MESSAGE_LIMIT, 'message is too long');
      fields = { text: formatted.text, entities: formatted.entities.length ? formatted.entities : undefined };
    } else if (content?.rich_message !== undefined) {
      fields = { rich_message: this.rich(content.rich_message) } as Partial<Message>;
    } else {
      const kind = (['photo', 'video', 'gif', 'mpeg4_gif', 'document', 'audio', 'voice', 'sticker'] as const).find((k) => r.type === k) ?? 'photo';
      const simKind: SimMediaKind = kind === 'gif' || kind === 'mpeg4_gif' ? 'animation' : kind;
      const source = r[`${kind}_url`] ?? r[`${kind}_file_id`] ?? r.photo_url;
      media = this.mediaFrom(simKind, source);
      const caption = r.caption ? this.format(r.caption, r.parse_mode, r.caption_entities, CAPTION_LIMIT, 'message caption is too long') : undefined;
      fields = { ...this.mediaFields(simKind, media), caption: caption?.text, caption_entities: caption?.entities.length ? caption.entities : undefined };
    }
    const markup = r.reply_markup as InlineKeyboardMarkup | undefined;
    if (markup) this.checkMarkup(markup);
    const inlineMessageId = markup ? `inline-${this.nextQuery++}` : undefined;
    const message = this.push(chat, this.userOf(userId), { ...fields, via_bot: this.botUser(), reply_markup: markup }, false, media);
    message.inlineMessageId = inlineMessageId;
    await this.deliver({
      chosen_inline_result: { result_id: r.id, from: this.userOf(userId), query, ...(inlineMessageId ? { inline_message_id: inlineMessageId } : {}) },
    } as Omit<Update, 'update_id'>);
    return message;
  }

  /** A user pays an invoice. Resolves with the bot's pre-checkout answer; on success a `successful_payment` message follows. */
  async pay(messageId: number, options: SendOptions = {}): Promise<{ ok: boolean; error?: string }> {
    const userId = options.user ?? this.user.id;
    const found = this.findMessage(options.chat ?? userId, messageId);
    const invoice = found?.message.invoice;
    if (!found || !invoice) throw new Error(`Message ${messageId} is not an invoice`);
    const payload = (found as SimMessage & { invoicePayload?: string }).invoicePayload ?? '';
    const id = String(this.nextQuery++);
    const answered = new Promise<{ ok: boolean; error?: string }>((resolve) => this.preCheckouts.set(id, resolve));
    await this.deliver({
      pre_checkout_query: { id, from: this.userOf(userId), currency: invoice.currency, total_amount: invoice.total_amount, invoice_payload: payload },
    } as Omit<Update, 'update_id'>);
    const answer = await Promise.race([answered, Promise.resolve({ ok: false, error: 'The bot did not answer' })]);
    this.preCheckouts.delete(id);
    if (!answer.ok) {
      this.emit('toast', { chatId: found.message.chat.id, userId, text: answer.error ?? 'Payment failed', alert: true });
      return answer;
    }
    await this.userMessage(
      {
        successful_payment: {
          currency: invoice.currency,
          total_amount: invoice.total_amount,
          invoice_payload: payload,
          telegram_payment_charge_id: `sim_${id}`,
          provider_payment_charge_id: `sim_provider_${id}`,
        },
      },
      { ...options, user: userId, chat: found.message.chat.id },
    );
    return answer;
  }

  /** The user presses stop under a draft the bot is streaming (`stopped_message_generation`). */
  async stopGeneration(chatId = this.user.id): Promise<void> {
    const chat = this.chatFor(chatId);
    const draft = chat.draft;
    if (!draft?.canStop) throw new Error('No draft with a stop button in this chat');
    chat.draft = null;
    this.emit('change', { chatId: chat.id });
    await this.deliver({ stopped_message_generation: { chat: this.chatObject(chat), draft_id: draft.id } } as unknown as Omit<Update, 'update_id'>);
  }

  /** A user joins a group. */
  async join(chatId: number, userId: number) {
    const chat = this.chatFor(chatId);
    const user = this.userOf(userId);
    chat.members.set(userId, { user, status: 'member', rights: {} });
    return this.userMessage({ new_chat_members: [user] }, { chat: chatId, user: userId });
  }

  /** A user leaves a group. */
  async leave(chatId: number, userId: number) {
    const chat = this.chatFor(chatId);
    const member = chat.members.get(userId);
    if (member) member.status = 'left';
    return this.userMessage({ left_chat_member: this.userOf(userId) }, { chat: chatId, user: userId });
  }

  /** A user blocks (or unblocks) the bot: sending to them fails with 403, like Telegram. */
  async block(userId = this.user.id, blocked = true) {
    const chat = this.privateChat(userId);
    chat.blocked = blocked;
    const status = (s: string) => ({ status: s, user: this.botUser() });
    await this.deliver({
      my_chat_member: {
        chat: this.chatObject(chat),
        from: this.userOf(userId),
        date: now(),
        old_chat_member: status(blocked ? 'member' : 'kicked'),
        new_chat_member: status(blocked ? 'kicked' : 'member'),
      },
    } as unknown as Omit<Update, 'update_id'>);
  }

  /** Feed any update (`update_id` is filled in). */
  async update(update: Omit<Update, 'update_id'>) {
    await this.deliver(update);
  }

  /* ------------------------------ delivery ------------------------------ */

  private async userMessage(fields: Partial<Message>, options: SendOptions, media?: SimMedia): Promise<SimMessage> {
    const userId = options.user ?? this.user.id;
    const chat = options.chat === undefined ? this.privateChat(userId) : this.chatFor(options.chat);
    const member = chat.members.get(userId);
    if (chat.type !== 'private' && !fields.new_chat_members && (!member || member.status === 'left' || member.status === 'kicked')) {
      throw new Error(`User ${userId} is not a member of ${chat.title ?? chat.id}`);
    }
    if (member?.status === 'restricted' && member.rights.can_send_messages === false && !fields.new_chat_members && !fields.left_chat_member) {
      throw new Error(`User ${userId} can't send messages in ${chat.title ?? chat.id}`);
    }
    if (chat.type === 'private') chat.started = true;
    if (options.ephemeral) {
      if (chat.type === 'private') throw new Error('Ephemeral messages are for groups and supergroups');
      const ephemeralId = this.nextEphemeralId(chat);
      fields = { ...fields, ephemeral_message_id: ephemeralId } as Partial<Message>;
      this.incomingEphemeral.set(`${chat.id}:${ephemeralId}`, { userId, at: Date.now() });
    }
    if (options.replyTo !== undefined) {
      const replied = this.findMessage(chat.id, options.replyTo);
      if (replied) fields = { ...fields, reply_to_message: replied.message as never };
    }
    if (chat.forceReply) chat.forceReply = null;
    const message = this.push(chat, this.userOf(userId), fields, false, media);
    if (options.ephemeral) message.receiver = userId; // nobody else in the group sees it
    await this.deliver({ message: message.message } as Omit<Update, 'update_id'>);
    return message;
  }

  private async deliver(update: Omit<Update, 'update_id'>) {
    const full = { update_id: this.updateId++, ...update } as Update;
    const bot = this.bot;
    if (!bot || bot.isRunning()) {
      // bot.start() (or a bot in another process, over handleRequest): hand it
      // out through getUpdates; grammY confirms it once handled.
      this.queue.push(full);
      this.waiting?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 30_000);
        const entry = { updateId: full.update_id, done };
        this.unconfirmed.push(entry);
        const unconfirmed = this.unconfirmed;
        function done() {
          clearTimeout(timer);
          const index = unconfirmed.indexOf(entry);
          if (index >= 0) unconfirmed.splice(index, 1);
          resolve();
        }
      });
      return;
    }
    try {
      if (!bot.isInited()) await bot.init();
      await bot.handleUpdate(full);
    } catch (error) {
      this.emit('error', { error });
      if (!this.listeners.get('error')?.size) throw error;
    }
  }

  private open(url: string, kind: SimEvents['open']['kind'], chatId: number | undefined, userId: number): SimCallbackAnswer {
    this.emit('open', { url, kind, chatId, userId });
    return { url };
  }

  /* ------------------------------ Bot API ------------------------------ */

  private async call(method: string, payload: Record<string, any>, signal?: AbortSignal): Promise<ApiResult> {
    if (this.latencyMs && method !== 'getUpdates') await sleep(this.latencyMs);
    const entry: SimApiCall = { method, payload, at: Date.now() };
    try {
      const handler = (this.methods as Record<string, ((p: Record<string, any>, signal?: AbortSignal) => unknown) | undefined>)[method];
      if (!handler) throw new ApiError(404, `Not Found: the simulator doesn't support the method "${method}"`);
      if (payload.ephemeral_message_parameters && !EPHEMERAL_METHODS.has(method)) throw badRequest(`${method} can't send ephemeral messages`);
      this.checkRate(method, payload);
      const result = await handler.call(this, payload, signal);
      entry.result = result;
      if (method !== 'getUpdates') this.log(entry);
      return { ok: true, result };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      entry.error = error.message;
      this.log(entry);
      return { ok: false, error_code: error.code, description: error.message, ...(error.parameters ? { parameters: error.parameters } : {}) };
    }
  }

  /** Telegram's flood control: throws 429 with `retry_after` when a limit is used up, else counts the call. */
  private checkRate(method: string, payload: Record<string, any>) {
    const limits = this.rateLimits;
    if (!limits || !RATE_LIMITED.test(method)) return;
    const cost = method === 'sendMediaGroup' && Array.isArray(payload.media) ? payload.media.length : 1;
    const chat = payload.chat_id === undefined ? undefined : this.chats.get(Number(payload.chat_id));
    const rules: [string, SimRateLimit | false | undefined][] = [['global', limits.global]];
    if (chat) rules.push([`chat:${chat.id}`, chat.type === 'private' ? limits.privateChat : limits.groupChat]);
    const now = Date.now();
    const active = rules.filter((r): r is [string, SimRateLimit] => !!r[1]);
    // Fixed windows, like app.throttle (Telegram doesn't document its own).
    const counters = active.map(([key, rule]) => {
      const window = Math.floor(now / rule.perMs);
      const counter = this.sendLog.get(key);
      return { key, rule, window, count: counter?.window === window ? counter.count : 0 };
    });
    for (const { rule, window, count } of counters) {
      // An album bigger than the limit fits an empty window.
      if (count + Math.min(cost, rule.limit) > rule.limit) {
        const retryAfter = Math.max(1, Math.ceil(((window + 1) * rule.perMs - now) / 1000));
        throw new ApiError(429, `Too Many Requests: retry after ${retryAfter}`, { retry_after: retryAfter });
      }
    }
    for (const { key, window, count } of counters) this.sendLog.set(key, { window, count: count + cost });
  }

  private log(entry: SimApiCall) {
    this.calls.push(entry);
    if (this.calls.length > this.callLimit) this.calls.splice(0, this.calls.length - this.callLimit);
    this.emit('call', entry);
  }

  private readonly methods = {
    getMe: () => this.botInfo,
    logOut: () => true,
    close: () => true,
    deleteWebhook: () => true,
    setWebhook: () => true,
    getWebhookInfo: () => ({ url: '', has_custom_certificate: false, pending_update_count: this.queue.length }),

    getUpdates: async (p: Record<string, any>, signal?: AbortSignal) => {
      const offset = p.offset ?? 0;
      if (!this.polled) {
        this.polled = true;
        this.pollWaiters.splice(0).forEach((resolve) => resolve());
      }
      while (this.queue.length && this.queue[0]!.update_id < offset) this.queue.shift();
      for (const entry of this.unconfirmed.filter((e) => e.updateId < offset)) entry.done();
      if (!this.queue.length && (p.timeout ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.min(p.timeout * 1000, 30_000));
          signal?.addEventListener('abort', done);
          this.waiting = done;
          function done() {
            clearTimeout(timer);
            resolve();
          }
        });
        this.waiting = null;
      }
      return this.queue.slice(0, p.limit ?? 100);
    },

    sendMessage: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id);
      const formatted = this.format(String(p.text ?? ''), p.parse_mode, p.entities, MESSAGE_LIMIT, 'message is too long');
      if (!formatted.text.trim()) throw badRequest('message text is empty');
      return this.botMessage(chat, p, { text: formatted.text, entities: formatted.entities.length ? formatted.entities : undefined }).message;
    },

    sendRichMessage: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id);
      return this.botMessage(chat, p, { rich_message: this.rich(p.rich_message) } as Partial<Message>).message;
    },

    ...Object.fromEntries(
      MEDIA_KINDS.map((kind) => [
        `send${kind === 'video_note' ? 'VideoNote' : kind[0]!.toUpperCase() + kind.slice(1)}`,
        (p: Record<string, any>) => {
          const chat = this.target(p.chat_id);
          const media = this.mediaFrom(kind, p[kind], p[kind]?.filename);
          const caption = this.caption(p);
          return this.botMessage(chat, p, { ...this.mediaFields(kind, media), ...caption }, media).message;
        },
      ]),
    ),

    sendMediaGroup: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id);
      const items = p.media as Record<string, any>[];
      if (!Array.isArray(items) || items.length < 2 || items.length > 10) throw badRequest('wrong number of media items, must be 2-10');
      const group = String(this.nextFile++);
      return items.map((item) => {
        const kind = item.type as SimMediaKind;
        const media = this.mediaFrom(kind, item.media, item.media?.filename);
        return this.botMessage(chat, { ...p, reply_markup: undefined }, { ...this.mediaFields(kind, media), ...this.caption(item), media_group_id: group }, media)
          .message;
      });
    },

    sendLocation: (p: Record<string, any>) =>
      this.botMessage(this.target(p.chat_id), p, { location: { latitude: p.latitude, longitude: p.longitude } }).message,
    sendContact: (p: Record<string, any>) =>
      this.botMessage(this.target(p.chat_id), p, { contact: { phone_number: p.phone_number, first_name: p.first_name, last_name: p.last_name } }).message,
    sendDice: (p: Record<string, any>) => {
      const emoji = p.emoji ?? '🎲';
      const max = emoji === '🎰' ? 64 : emoji === '🏀' || emoji === '⚽' ? 5 : 6;
      return this.botMessage(this.target(p.chat_id), p, { dice: { emoji, value: 1 + Math.floor(Math.random() * max) } }).message;
    },
    sendPoll: (p: Record<string, any>) =>
      this.botMessage(this.target(p.chat_id), p, {
        poll: {
          id: String(this.nextQuery++),
          question: p.question,
          options: (p.options as (string | { text: string })[]).map((o) => ({ text: typeof o === 'string' ? o : o.text, voter_count: 0 })),
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: p.is_anonymous ?? true,
          type: p.type ?? 'regular',
          allows_multiple_answers: !!p.allows_multiple_answers,
        },
      } as never).message,

    sendInvoice: (p: Record<string, any>) => {
      const prices = p.prices as { label: string; amount: number }[];
      const total = prices.reduce((sum, price) => sum + price.amount, 0);
      const markup = p.reply_markup ?? { inline_keyboard: [[{ text: `Pay ${formatAmount(total, p.currency)}`, pay: true }]] };
      const sent = this.botMessage(this.target(p.chat_id), { ...p, reply_markup: markup }, {
        invoice: { title: p.title, description: p.description, start_parameter: p.start_parameter ?? '', currency: p.currency, total_amount: total },
      });
      (sent as SimMessage & { invoicePayload?: string }).invoicePayload = p.payload;
      if (p.photo_url) sent.media = { kind: 'photo', url: p.photo_url };
      return sent.message;
    },

    sendRichMessageDraft: (p: Record<string, any>) => this.methods.sendMessageDraft(p),

    sendMessageDraft: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id);
      if (chat.type !== 'private') throw badRequest('message drafts can be sent only to private chats');
      if (!Number.isInteger(p.draft_id) || p.draft_id === 0) throw badRequest('draft_id must be a non-zero integer');
      const rich = p.rich_message === undefined ? undefined : this.rich(p.rich_message);
      const text = rich ? richPlainText(rich) : String(p.text ?? '');
      if (!rich && text.length > 4096) throw badRequest('message is too long');
      const until = Date.now() + 30_000;
      chat.draft = { id: p.draft_id, text, canStop: !!p.can_stop, until, ...(rich ? { rich } : {}) };
      setTimeout(() => {
        if (chat.draft?.until === until) {
          chat.draft = null;
          this.emit('change', { chatId: chat.id });
        }
      }, 30_000).unref?.();
      this.emit('change', { chatId: chat.id });
      return true;
    },

    sendChatAction: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id);
      chat.action = { action: p.action, until: Date.now() + 5000 };
      clearTimeout(this.actionTimers.get(chat.id));
      this.actionTimers.set(
        chat.id,
        setTimeout(() => {
          if (chat.action && chat.action.until <= Date.now()) {
            chat.action = null;
            this.emit('change', { chatId: chat.id });
          }
        }, 5000),
      );
      this.emit('change', { chatId: chat.id });
      return true;
    },

    editMessageText: (p: Record<string, any>) => {
      const found = this.editable(p);
      // Text and rich messages edit into each other; media messages have no text to edit.
      if (found.message.text === undefined && found.message.rich_message === undefined) throw badRequest('there is no text in the message to edit');
      if (p.rich_message !== undefined) {
        const rich_message = this.rich(p.rich_message);
        return this.applyEdit(found, p, { rich_message, text: undefined, entities: undefined, link_preview_options: undefined } as Partial<Message>, () => same(found.message.rich_message, rich_message));
      }
      const formatted = this.format(String(p.text ?? ''), p.parse_mode, p.entities, MESSAGE_LIMIT, 'message is too long');
      if (!formatted.text.trim()) throw badRequest('message text is empty');
      const entities = formatted.entities.length ? formatted.entities : undefined;
      return this.applyEdit(found, p, { text: formatted.text, entities, rich_message: undefined } as Partial<Message>, () => found.message.text === formatted.text && same(found.message.entities, entities));
    },

    editMessageCaption: (p: Record<string, any>) => {
      const found = this.editable(p);
      if (!found.media) throw badRequest('there is no caption in the message to edit');
      const caption = this.caption(p);
      return this.applyEdit(found, p, caption, () => found.message.caption === caption.caption && same(found.message.caption_entities, caption.caption_entities));
    },

    editMessageMedia: (p: Record<string, any>) => {
      const found = this.editable(p);
      // Since Bot API 10.x a text message can be turned into a media message too.
      if (!found.media && found.message.text === undefined) throw badRequest('there is no media in the message to edit');
      const item = p.media as Record<string, any>;
      const kind = item.type as SimMediaKind;
      const media = this.mediaFrom(kind, item.media, item.media?.filename);
      const cleared = { ...Object.fromEntries(MEDIA_KINDS.map((k) => [k, undefined])), text: undefined, entities: undefined, link_preview_options: undefined, rich_message: undefined };
      found.media = media;
      return this.applyEdit(found, p, { ...cleared, ...this.mediaFields(kind, media), ...this.caption(item) }, () => false);
    },

    editMessageReplyMarkup: (p: Record<string, any>) => {
      const found = this.editable(p);
      return this.applyEdit(found, p, {}, () => true);
    },

    // Ephemeral messages are edited and deleted by chat, receiver and ephemeral id; edits answer true.
    editEphemeralMessageText: (p: Record<string, any>) => (this.methods.editMessageText(p), true),
    editEphemeralMessageCaption: (p: Record<string, any>) => (this.methods.editMessageCaption(p), true),
    editEphemeralMessageMedia: (p: Record<string, any>) => (this.methods.editMessageMedia(p), true),
    editEphemeralMessageReplyMarkup: (p: Record<string, any>) => (this.methods.editMessageReplyMarkup(p), true),
    deleteEphemeralMessage: (p: Record<string, any>) => {
      const found = this.editable(p);
      const chat = this.chats.get(found.message.chat.id)!;
      chat.messages = chat.messages.filter((m) => m !== found);
      // The message it replaced shows again on the receiver's screen.
      const original = found.replaced === undefined ? undefined : chat.messages.find((m) => m.message.message_id === found.replaced && m.receiver === undefined);
      if (original?.hiddenFor) original.hiddenFor = original.hiddenFor.filter((u) => u !== p.receiver_user_id);
      this.emit('change', { chatId: chat.id });
      return true;
    },

    deleteMessage: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      if (!this.remove(chat, [p.message_id])) throw badRequest('message to delete not found');
      return true;
    },

    deleteMessages: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      this.remove(chat, p.message_ids);
      return true;
    },

    copyMessage: (p: Record<string, any>) => ({ message_id: this.copy(p, p.message_id, false, true) }),
    copyMessages: (p: Record<string, any>) => (p.message_ids as number[]).map((id) => ({ message_id: this.copy(p, id, false, true) })),
    forwardMessage: (p: Record<string, any>) => this.copy(p, p.message_id, true).message,
    forwardMessages: (p: Record<string, any>) => (p.message_ids as number[]).map((id) => ({ message_id: this.copy(p, id, true).message.message_id })),

    answerCallbackQuery: (p: Record<string, any>) => {
      const query = this.callbackQueries.get(String(p.callback_query_id));
      if (!query || query.answer) throw badRequest('query is too old and response timeout expired or query ID is invalid');
      query.answer = { text: p.text, alert: !!p.show_alert, url: p.url };
      if (p.text) this.emit('toast', { chatId: query.chatId, userId: query.userId, text: p.text, alert: !!p.show_alert });
      if (p.url) this.open(p.url, 'game', query.chatId, query.userId);
      return true;
    },

    answerInlineQuery: (p: Record<string, any>) => {
      const resolve = this.inlineQueries.get(String(p.inline_query_id));
      if (!resolve) throw badRequest('query is too old and response timeout expired or query ID is invalid');
      for (const result of p.results as Record<string, any>[]) if (result.reply_markup) this.checkMarkup(result.reply_markup);
      resolve(p.results);
      return true;
    },

    answerPreCheckoutQuery: (p: Record<string, any>) => {
      const resolve = this.preCheckouts.get(String(p.pre_checkout_query_id));
      if (!resolve) throw badRequest('query is too old and response timeout expired or query ID is invalid');
      resolve({ ok: !!p.ok, error: p.error_message });
      return true;
    },

    answerWebAppQuery: (p: Record<string, any>) => ({ inline_message_id: `webapp-${p.web_app_query_id}` }),
    savePreparedInlineMessage: () => ({ id: `prepared-${this.nextQuery++}`, expiration_date: now() + 3600 }),

    getChat: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      return { ...this.chatObject(chat), accent_color_id: 0, max_reaction_count: 11 };
    },
    getChatMember: (p: Record<string, any>) => this.memberObject(this.target(p.chat_id, true), p.user_id),
    getChatAdministrators: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      return [...chat.members.values()].filter((m) => m.status === 'creator' || m.status === 'administrator').map((m) => this.memberObject(chat, m.user.id));
    },
    getChatMemberCount: (p: Record<string, any>) => [...this.target(p.chat_id, true).members.values()].filter((m) => !['left', 'kicked'].includes(m.status)).length,
    banChatMember: (p: Record<string, any>) => this.setMember(p, 'kicked', {}),
    unbanChatMember: (p: Record<string, any>) => this.setMember(p, 'left', {}),
    restrictChatMember: (p: Record<string, any>) => {
      const permissions = p.permissions as Record<string, boolean>;
      const everything = Object.values(permissions).every(Boolean);
      return this.setMember(p, everything ? 'member' : 'restricted', permissions);
    },
    promoteChatMember: (p: Record<string, any>) => {
      const rights = Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith('can_') || k === 'is_anonymous')) as Record<string, boolean>;
      return this.setMember(p, Object.values(rights).some(Boolean) ? 'administrator' : 'member', rights);
    },
    leaveChat: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      chat.members.delete(this.botInfo.id);
      this.emit('change', { chatId: chat.id });
      return true;
    },
    pinChatMessage: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      if (!this.findMessage(chat.id, p.message_id)) throw badRequest('message to pin not found');
      chat.pinned = [...chat.pinned.filter((id) => id !== p.message_id), p.message_id];
      this.emit('change', { chatId: chat.id });
      return true;
    },
    unpinChatMessage: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      chat.pinned = p.message_id === undefined ? chat.pinned.slice(0, -1) : chat.pinned.filter((id) => id !== p.message_id);
      this.emit('change', { chatId: chat.id });
      return true;
    },
    unpinAllChatMessages: (p: Record<string, any>) => {
      this.target(p.chat_id, true).pinned = [];
      return true;
    },
    setMessageReaction: (p: Record<string, any>) => {
      const found = this.findMessage(this.target(p.chat_id, true).id, p.message_id);
      if (!found) throw badRequest('message to react not found');
      (found as SimMessage & { reactions?: unknown }).reactions = p.reaction;
      this.emit('change', { chatId: found.message.chat.id });
      return true;
    },

    setMyCommands: (p: Record<string, any>) => {
      const commands = p.commands as BotCommand[];
      if (!Array.isArray(commands) || commands.length > 100) throw badRequest('commands must be a list of at most 100 commands');
      for (const c of commands) {
        if (!/^[a-z0-9_]{1,32}$/.test(c.command)) throw badRequest('BOT_COMMAND_INVALID');
        if (!c.description || c.description.length > 256) throw badRequest('command description must be 1-256 characters');
      }
      this.commandLists.set(commandKey(p), commands);
      this.emit('change', {});
      return true;
    },
    getMyCommands: (p: Record<string, any>) => this.commandLists.get(commandKey(p)) ?? [],
    deleteMyCommands: (p: Record<string, any>) => {
      this.commandLists.delete(commandKey(p));
      this.emit('change', {});
      return true;
    },
    setChatMenuButton: () => true,
    getChatMenuButton: () => ({ type: 'commands' }),
    setMyDescription: () => true,
    setMyShortDescription: () => true,
    setMyName: () => true,
    setMyDefaultAdministratorRights: () => true,

    getFile: (p: Record<string, any>) => {
      const file = this.files.get(p.file_id);
      if (!file) throw badRequest('invalid file_id');
      return { file_id: p.file_id, file_unique_id: p.file_id, file_size: this.fileData.get(p.file_id)?.size ?? 1024, file_path: `${file.kind}/${p.file_id}` };
    },
    getUserProfilePhotos: () => ({ total_count: 0, photos: [] }),
  };

  /* ------------------------------ internals ------------------------------ */

  private emit<K extends keyof SimEvents>(event: K, value: SimEvents[K]) {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private botUser(): User {
    const { id, is_bot, first_name, username } = this.botInfo;
    return { id, is_bot, first_name, username };
  }

  private userOf(id: number): User {
    const user = this.users.get(id);
    if (!user) throw new Error(`Unknown user ${id}: add it with sim.addUser(...)`);
    return user;
  }

  private newChat(id: number, type: Chat['type'], extra: { title?: string; user?: User }): SimChat {
    const chat: SimChat = {
      id,
      type,
      ...extra,
      members: new Map(),
      messages: [],
      replyKeyboard: null,
      replyKeyboardHidden: false,
      forceReply: null,
      action: null,
      pinned: [],
      started: type !== 'private',
      blocked: false,
      draft: null,
    };
    this.chats.set(id, chat);
    return chat;
  }

  private chatFor(id: number): SimChat {
    const chat = this.chats.get(id) ?? (this.users.has(id) ? this.privateChat(id) : undefined);
    if (!chat) throw new Error(`Unknown chat ${id}`);
    return chat;
  }

  /** The chat a bot call goes to, with Telegram's errors. */
  private target(chatId: number | string, any = false): SimChat {
    const id = typeof chatId === 'string' && /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
    const chat = typeof id === 'number' ? this.chats.get(id) : [...this.chats.values()].find((c) => `@${c.title}` === id);
    if (!chat) {
      if (typeof id === 'number' && this.users.has(id)) throw new ApiError(403, "Forbidden: bot can't initiate conversation with a user");
      throw badRequest('chat not found');
    }
    if (chat.type === 'private') {
      if (chat.blocked) throw new ApiError(403, 'Forbidden: bot was blocked by the user');
      if (!chat.started && !any) throw new ApiError(403, "Forbidden: bot can't initiate conversation with a user");
    } else if (!chat.members.has(this.botInfo.id)) {
      throw new ApiError(403, 'Forbidden: bot is not a member of the supergroup chat');
    }
    return chat;
  }

  private chatObject(chat: SimChat): Chat {
    if (chat.type === 'private') {
      const { first_name, last_name, username } = chat.user!;
      return { id: chat.id, type: 'private', first_name, ...(last_name ? { last_name } : {}), ...(username ? { username } : {}) } as Chat;
    }
    return { id: chat.id, type: chat.type, title: chat.title ?? '' } as Chat;
  }

  private memberObject(chat: SimChat, userId: number): ChatMember {
    const member = chat.members.get(userId);
    if (!member) {
      if (!this.users.has(userId) && userId !== this.botInfo.id) throw badRequest('user not found');
      return { status: 'left', user: userId === this.botInfo.id ? this.botUser() : this.userOf(userId) } as ChatMember;
    }
    const { status, user, rights } = member;
    if (status === 'administrator') {
      const all = [
        'can_be_edited',
        'can_manage_chat',
        'can_change_info',
        'can_delete_messages',
        'can_invite_users',
        'can_restrict_members',
        'can_pin_messages',
        'can_manage_topics',
        'can_promote_members',
        'can_manage_video_chats',
        'can_post_stories',
        'can_edit_stories',
        'can_delete_stories',
      ];
      return { status, user, is_anonymous: false, ...Object.fromEntries(all.map((r) => [r, rights[r] ?? true])) } as ChatMember;
    }
    if (status === 'restricted') return { status, user, is_member: true, until_date: member.until ?? 0, ...rights } as ChatMember;
    if (status === 'kicked') return { status, user, until_date: member.until ?? 0 } as ChatMember;
    if (status === 'creator') return { status, user, is_anonymous: false } as ChatMember;
    return { status, user } as ChatMember;
  }

  private setMember(p: Record<string, any>, status: SimMember['status'], rights: Record<string, boolean>) {
    const chat = this.target(p.chat_id, true);
    if (chat.type === 'private') throw badRequest('method is available for supergroup and channel chats only');
    const existing = chat.members.get(p.user_id);
    if (existing?.status === 'creator') throw badRequest("can't remove chat owner");
    if (status === 'left' && existing?.status !== 'kicked') return true; // unban of someone not banned
    chat.members.set(p.user_id, { user: this.userOf(p.user_id), status, rights, until: p.until_date });
    this.emit('change', { chatId: chat.id });
    return true;
  }

  private format(text: string, parseMode: string | undefined, entities: MessageEntity[] | undefined, limit: number, tooLong: string) {
    let formatted;
    try {
      formatted = parseFormatted(text, parseMode, entities);
    } catch (error) {
      if (error instanceof ParseError) throw badRequest(`can't parse entities: ${error.message}`);
      throw error;
    }
    if (formatted.text.length > limit) throw badRequest(tooLong);
    return formatted;
  }

  private caption(p: Record<string, any>): { caption?: string; caption_entities?: MessageEntity[] } {
    if (p.caption === undefined || p.caption === '') return { caption: undefined, caption_entities: undefined };
    const formatted = this.format(String(p.caption), p.parse_mode, p.caption_entities, CAPTION_LIMIT, 'message caption is too long');
    return { caption: formatted.text, caption_entities: formatted.entities.length ? formatted.entities : undefined };
  }

  private checkMarkup(markup: Record<string, any> | undefined) {
    const rows = markup?.inline_keyboard as InlineKeyboardButton[][] | undefined;
    if (!rows) return;
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) throw badRequest("field \"inline_keyboard\" of the InlineKeyboardMarkup must be an Array of Arrays");
    for (const button of rows.flat()) {
      if (!button.text) throw badRequest('text buttons are unallowed in the inline keyboard');
      if ('callback_data' in button && new TextEncoder().encode(button.callback_data).length > 64) throw badRequest('BUTTON_DATA_INVALID');
      const kinds = ['callback_data', 'url', 'web_app', 'login_url', 'switch_inline_query', 'switch_inline_query_current_chat', 'switch_inline_query_chosen_chat', 'copy_text', 'callback_game', 'pay', 'disabled'];
      if (!kinds.some((k) => k in button)) throw badRequest('text buttons are unallowed in the inline keyboard');
    }
  }

  private registerFile(media: SimMedia): string {
    const id = `sim-${media.kind}-${this.nextFile++}`;
    this.files.set(id, media);
    const data = this.mediaData.get(media);
    if (data) this.fileData.set(id, data);
    return id;
  }

  /** What the UI can show for a media source: a URL, an InputFile (Blob, bytes, URL) or a file id. */
  private mediaFrom(kind: SimMediaKind, source: unknown, filename?: string): SimMedia {
    if (typeof source === 'string') {
      const known = this.files.get(source);
      if (known) {
        const media = { ...known, kind };
        const data = this.fileData.get(source);
        if (data) this.mediaData.set(media, data);
        return media;
      }
      if (/^(https?:|data:|blob:)/.test(source)) return { kind, url: source, name: filename ?? source.split('/').pop()?.split('?')[0] };
      return { kind, name: filename };
    }
    // A file uploaded over HTTP (handleRequest), or an InputFile's contents.
    const data = typeof Blob !== 'undefined' && source instanceof Blob ? source : (source as { fileData?: unknown } | undefined)?.fileData;
    const name = filename ?? (source as { filename?: string; name?: string } | undefined)?.filename ?? (source as { name?: string } | undefined)?.name;
    if (data instanceof URL) return { kind, url: data.href, name };
    if (typeof data === 'string' && /^(https?:|data:|blob:)/.test(data)) return { kind, url: data, name };
    if (typeof Blob !== 'undefined' && (data instanceof Blob || data instanceof Uint8Array)) {
      const blob = data instanceof Blob ? data : new Blob([data as never]);
      const createUrl = (globalThis as { URL?: { createObjectURL?: (blob: Blob) => string } }).URL?.createObjectURL;
      const media: SimMedia = { kind, url: this.storeFile ? this.storeFile(blob, name) : createUrl?.(blob), name };
      this.mediaData.set(media, blob);
      return media;
    }
    return { kind, name };
  }

  private mediaFields(kind: SimMediaKind, media: SimMedia): Partial<Message> {
    const fileId = this.registerFile(media);
    const file = { file_id: fileId, file_unique_id: fileId, file_size: 1024 };
    switch (kind) {
      case 'photo':
        return { photo: [{ ...file, width: 90, height: 90 }, { ...file, width: 1280, height: 960 }] };
      case 'video':
      case 'animation':
        return { [kind]: { ...file, width: 640, height: 360, duration: 5, file_name: media.name } } as Partial<Message>;
      case 'audio':
        return { audio: { ...file, duration: 30, file_name: media.name, title: media.name } };
      case 'voice':
        return { voice: { ...file, duration: 5 } };
      case 'video_note':
        return { video_note: { ...file, length: 240, duration: 5 } };
      case 'sticker':
        return { sticker: { ...file, width: 512, height: 512, type: 'regular', is_animated: false, is_video: false } };
      default:
        return { document: { ...file, file_name: media.name ?? 'file' } };
    }
  }

  /** A rich message's content as Telegram stores it; media blocks register their files. */
  private rich(input: unknown): RichMessage {
    if (!input || typeof input !== 'object') throw badRequest('rich_message must be an object');
    try {
      return parseRichMessage(input as Record<string, any>, (kind, source, extra) => this.richMedia(kind, source, extra));
    } catch (error) {
      if (error instanceof RichMessageError) throw badRequest(error.message);
      throw error;
    }
  }

  private richMedia(kind: RichMediaKind, source: unknown, extra: { caption?: unknown; spoiler?: boolean }): RichBlock {
    const simKind: SimMediaKind = kind === 'voice_note' ? 'voice' : kind;
    const media = this.mediaFrom(simKind, source);
    const fields = this.mediaFields(simKind, media) as Record<string, unknown>;
    const caption = extra.caption ? { caption: extra.caption } : {};
    const spoiler = extra.spoiler && ['photo', 'video', 'animation'].includes(kind) ? { has_spoiler: true } : {};
    return { type: kind, [kind]: fields[simKind], ...caption, ...spoiler } as unknown as RichBlock;
  }

  /** A URL a browser can show for a file the bot sent (photos, videos… also inside rich messages). */
  fileUrl(fileId: string): string | undefined {
    return this.files.get(fileId)?.url;
  }

  private botMessage(chat: SimChat, p: Record<string, any>, fields: Partial<Message>, media?: SimMedia): SimMessage {
    const markup = p.reply_markup as Record<string, any> | undefined;
    this.checkMarkup(markup);
    const ephemeral = p.ephemeral_message_parameters ? this.authorizeEphemeral(chat, p) : undefined;
    if (ephemeral) {
      if (markup && !markup.inline_keyboard) throw badRequest('only inline keyboards can be used in ephemeral messages');
      fields = { ...fields, ephemeral_message_id: this.nextEphemeralId(chat), receiver_user: this.userOf(ephemeral.receiver) } as Partial<Message>;
    }
    const replyTo = p.reply_parameters?.message_id ?? p.reply_to_message_id;
    if (replyTo !== undefined) {
      const replied = this.findMessage(chat.id, replyTo);
      if (replied) fields = { ...fields, reply_to_message: replied.message as never };
      else if (!p.reply_parameters?.allow_sending_without_reply) throw badRequest('message to be replied not found');
    }
    if (markup?.keyboard) {
      chat.replyKeyboard = markup as ReplyKeyboardMarkup;
      chat.replyKeyboardHidden = false;
      chat.forceReply = null;
    } else if (markup?.remove_keyboard) chat.replyKeyboard = null;
    else if (markup?.force_reply) chat.forceReply = markup as ForceReply;
    chat.action = null;
    chat.draft = null; // a message from the bot ends the draft
    const inline = markup?.inline_keyboard ? { reply_markup: markup as InlineKeyboardMarkup } : {};
    const sent = this.push(chat, this.botUser(), { ...fields, ...inline, ...(p.protect_content ? { has_protected_content: true } : {}) } as Partial<Message>, true, media);
    if (ephemeral) {
      sent.receiver = ephemeral.receiver;
      // Shown in place of the pressed message, on the receiver's screen only.
      if (ephemeral.replaces) {
        ephemeral.replaces.hiddenFor = [...(ephemeral.replaces.hiddenFor ?? []), ephemeral.receiver];
        sent.replaced = ephemeral.replaces.message.message_id;
      }
      this.emit('change', { chatId: chat.id });
    }
    return sent;
  }

  private nextEphemeralId(chat: SimChat): number {
    const id = (this.ephemeralIds.get(chat.id) ?? 0) + 1;
    this.ephemeralIds.set(chat.id, id);
    return id;
  }

  /**
   * Telegram's rules for ephemeral messages: groups only, to a member; a bot
   * that isn't an admin answers within 15 s of a button press
   * (`callback_query_id`) or an ephemeral command (replying to it).
   */
  private authorizeEphemeral(chat: SimChat, p: Record<string, any>): { receiver: number; replaces?: SimMessage } {
    const e = p.ephemeral_message_parameters as { receiver_user_id: number; callback_query_id?: string; replace_callback_query_message?: boolean };
    if (chat.type !== 'group' && chat.type !== 'supergroup') throw badRequest('ephemeral messages can be sent only to groups and supergroups');
    const member = chat.members.get(e.receiver_user_id);
    if (!member || ['left', 'kicked'].includes(member.status) || member.user.is_bot) throw badRequest('user not found');
    const status = chat.members.get(this.botInfo.id)?.status;
    const admin = status === 'administrator' || status === 'creator';
    const now = Date.now();

    const query = e.callback_query_id === undefined ? undefined : this.callbackQueries.get(String(e.callback_query_id));
    if (e.callback_query_id !== undefined && (!query || query.userId !== e.receiver_user_id || query.chatId !== chat.id)) {
      throw badRequest('query is too old and response timeout expired or query ID is invalid');
    }
    const freshQuery = !!query && now - query.at <= 15_000;
    const replyTo = p.reply_parameters?.ephemeral_message_id;
    const incoming = replyTo === undefined ? undefined : this.incomingEphemeral.get(`${chat.id}:${replyTo}`);
    if (replyTo !== undefined && (!incoming || incoming.userId !== e.receiver_user_id)) throw badRequest('message to be replied not found');
    const freshReply = !!incoming && now - incoming.at <= 15_000;
    if (!admin && !freshQuery && !freshReply) {
      // The simulator's wording: Telegram refuses, but its exact text isn't documented.
      throw new ApiError(403, 'Forbidden: a bot that is not an admin can send an ephemeral message only within 15 seconds of a button press or an ephemeral command');
    }

    let replaces: SimMessage | undefined;
    if (e.replace_callback_query_message) {
      if (!query?.message) throw badRequest('replace_callback_query_message needs callback_query_id');
      if (query.message.receiver !== undefined) throw badRequest('replace_callback_query_message must be False for callback queries from ephemeral messages');
      replaces = query.message;
    }
    return { receiver: e.receiver_user_id, replaces };
  }

  private push(chat: SimChat, from: User, fields: Partial<Message>, fromBot: boolean, media?: SimMedia): SimMessage {
    const id = (this.messageIds.get(chat.id) ?? 0) + 1;
    this.messageIds.set(chat.id, id);
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const message = { message_id: id, date: now(), chat: this.chatObject(chat), from, ...clean } as Message;
    const sim: SimMessage = { message, fromBot, ...(media ? { media } : {}) };
    chat.messages.push(sim);
    this.emit('change', { chatId: chat.id });
    return sim;
  }

  private findMessage(chatId: number, messageId: number): SimMessage | undefined {
    return this.chats.get(chatId)?.messages.find((m) => m.message.message_id === messageId);
  }

  private findInline(inlineMessageId: string): SimMessage | undefined {
    for (const chat of this.chats.values()) {
      const found = chat.messages.find((m) => m.inlineMessageId === inlineMessageId);
      if (found) return found;
    }
    return undefined;
  }

  private editable(p: Record<string, any>): SimMessage {
    if (p.ephemeral_message_id !== undefined) {
      const chat = this.target(p.chat_id, true);
      const found = chat.messages.find((m) => m.message.ephemeral_message_id === p.ephemeral_message_id && m.receiver === p.receiver_user_id && m.fromBot);
      if (!found) throw badRequest('message to edit not found');
      return found;
    }
    if (p.inline_message_id !== undefined) {
      const found = this.findInline(p.inline_message_id);
      if (!found) throw badRequest('message to edit not found');
      return found;
    }
    const chat = this.target(p.chat_id, true);
    const found = this.findMessage(chat.id, p.message_id);
    if (!found) throw badRequest('message to edit not found');
    if (!found.fromBot) throw badRequest("message can't be edited");
    return found;
  }

  /** Edits keep the message where it is; no reply_markup removes the inline keyboard, like Telegram. */
  private applyEdit(found: SimMessage, p: Record<string, any>, fields: Partial<Message>, contentSame: () => boolean) {
    const markup = p.reply_markup?.inline_keyboard ? (p.reply_markup as InlineKeyboardMarkup) : undefined;
    this.checkMarkup(markup);
    if (contentSame() && same(found.message.reply_markup, markup)) throw badRequest(NOT_MODIFIED.slice('Bad Request: '.length));
    const next = { ...found.message, ...fields, reply_markup: markup, edit_date: now() } as Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    found.message = next as unknown as Message;
    this.emit('change', { chatId: found.message.chat.id });
    return found.inlineMessageId && p.inline_message_id !== undefined ? true : found.message;
  }

  private remove(chat: SimChat, ids: number[]): boolean {
    const before = chat.messages.length;
    chat.messages = chat.messages.filter((m) => !ids.includes(m.message.message_id));
    if (chat.messages.length === before) return false;
    this.emit('change', { chatId: chat.id });
    return true;
  }

  private copy(p: Record<string, any>, messageId: number, forward: boolean, idOnly?: true): any {
    const from = this.target(p.from_chat_id, true);
    const source = this.findMessage(from.id, messageId);
    if (!source) throw badRequest('message to copy not found');
    const chat = this.target(p.chat_id);
    const { message_id: _id, date: _date, chat: _chat, from: author, reply_markup: _markup, edit_date: _edit, ...content } = source.message as Message & Record<string, unknown>;
    const caption = !forward && p.caption !== undefined ? this.caption(p) : {};
    const fields = forward ? { ...content, forward_origin: { type: 'user', sender_user: author, date: source.message.date } } : { ...content, ...caption };
    const sent = this.botMessage(chat, forward ? { ...p, reply_markup: undefined } : p, fields as Partial<Message>, source.media);
    return idOnly ? sent.message.message_id : sent;
  }
}

const NUMERIC = /(^|_)(id|ids|offset|limit|timeout|latitude|longitude|date|duration|width|height|amount|period|count|radius|heading|position|length)$/;

/** A Bot API request body as the payload object grammY sent. */
async function readPayload(request: Request, url: URL): Promise<Record<string, any>> {
  const type = request.headers.get('content-type') ?? '';
  // grammY compresses request bodies (node-fetch's `compress`), like Telegram allows.
  const encoding = request.headers.get('content-encoding')?.toLowerCase();
  if (request.body && (encoding === 'gzip' || encoding === 'deflate')) {
    const body = request.body.pipeThrough(new DecompressionStream(encoding) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const headers = new Headers(request.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    request = new Request(request.url, { method: request.method, headers, body, duplex: 'half' } as RequestInit);
  }
  if (type.includes('application/json')) {
    const text = await request.text();
    return (text.trim() ? JSON.parse(text) : {}) as Record<string, any>;
  }
  const entries: [string, string | Blob][] = [...url.searchParams];
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    for (const [key, value] of (await request.formData()) as unknown as Iterable<[string, string | Blob]>) entries.push([key, value]);
  }
  // Files come as parts of their own, referenced as "attach://<name>" (grammY
  // sends every InputFile like that, top-level ones too).
  const files = new Map(entries.filter((e): e is [string, Blob] => typeof e[1] !== 'string'));
  const revive = (value: unknown): unknown => {
    if (typeof value === 'string') return value.startsWith('attach://') ? (files.get(value.slice(9)) ?? value) : value;
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === 'object' && !(value instanceof Blob)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
    return value;
  };
  const payload: Record<string, any> = {};
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      if (!key.match(/^[a-z0-9]{16}$/)) payload[key] = value; // a file sent under the param's own name
      continue;
    }
    let parsed: unknown = value;
    if (/^[[{]/.test(value)) {
      try {
        parsed = JSON.parse(value);
      } catch {}
    } else if (value === 'true' || value === 'false') parsed = value === 'true';
    else if (NUMERIC.test(key) && /^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value);
    payload[key] = revive(parsed);
  }
  return payload;
}

function commandKey(p: Record<string, any>) {
  const scope = (p.scope ?? { type: 'default' }) as { type: string; chat_id?: number | string; user_id?: number };
  const target = [scope.chat_id, scope.user_id].filter((part) => part !== undefined).join(':');
  return `${scope.type}${target ? `:${target}` : ''}|${p.language_code ?? ''}`;
}

function formatAmount(amount: number, currency: string) {
  if (currency === 'XTR') return `⭐️ ${amount}`;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${amount / 100} ${currency}`;
  }
}

/**
 * A Telegram simulator: an in-memory Bot API that a real grammY bot talks
 * to, plus simulated users who send messages, press buttons, pay invoices and
 * use inline mode. Nothing leaves the process, so it runs in browsers too
 * (the docs playgrounds), in tests, and in a local preview.
 *
 *   import { Bot } from 'grammy';
 *   import { TelegramSimulator } from '@easytg/simulator';
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
  ChatInviteLink,
  ChatMember,
  ChatPermissions,
  ForceReply,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  InlineQueryResult,
  KeyboardButton,
  Location,
  Message,
  MessageEntity,
  ReactionType,
  ReplyKeyboardMarkup,
  RichBlock,
  RichMessage,
  RichMessageButton,
  ShippingAddress,
  Sticker,
  StickerSet,
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
  /** A live location (`sendLocation` with `live_period`): until when it can be edited, in Unix time. */
  liveUntil?: number;
  /** Reactions on the message: by users (`react`) and by the bot (`setMessageReaction`). */
  reactions?: SimReaction[];
}

export interface SimReaction {
  /** Who reacted: a user (or the bot), or a chat reacting anonymously. */
  user?: number;
  actorChat?: number;
  reaction: ReactionType[];
}

/** An invite link the bot made (`exportChatInviteLink`, `createChatInviteLink`, …), as `ChatInviteLink`, plus who joined through it. */
export interface SimInviteLink extends ChatInviteLink {
  joined: number[];
}

/** A pending request to join a chat (`requestToJoin`, or `joinByLink` with a link that needs approval). */
export interface SimJoinRequest {
  userId: number;
  date: number;
  inviteLink?: string;
  bio?: string;
  /** For join requests with a query (`requestToJoin(…, { query: true })`): its id, until answered. */
  queryId?: string;
}

export interface SimMember {
  user: User;
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  /** Rights of an administrator (all true unless given), or permissions of a restricted member. */
  rights: Record<string, boolean>;
  until?: number;
  /** An administrator's title (`setChatAdministratorCustomTitle`). */
  customTitle?: string;
  /** A regular member's tag (`setChatMemberTag`). */
  tag?: string;
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
  /** A supergroup with topics (`is_forum`); its topics are in `topics`. */
  forum?: boolean;
  /** Forum topics, without "General" (thread 1, always there). */
  topics?: SimTopic[];
  /** "General" of a forum: renamed, closed or hidden by the bot. */
  general?: { name: string; closed: boolean; hidden: boolean };
  /** Set by `setChatDescription`. */
  description?: string;
  /** Set by `setChatPhoto` (`fileId` of the photo, `url` to show it), removed by `deleteChatPhoto`. */
  photo?: { fileId: string; url?: string };
  /** Default permissions of members (`setChatPermissions`); unset: everything allowed. */
  permissions?: ChatPermissions;
  /** Invite links the bot made; the primary one is `getChat`'s `invite_link`. */
  inviteLinks?: SimInviteLink[];
  /** Pending join requests, by user id. */
  joinRequests?: Map<number, SimJoinRequest>;
  /** The group sticker set (`setChatStickerSet`). */
  stickerSet?: string;
  /** Channels banned from writing (`banChatSenderChat`). */
  bannedSenderChats?: number[];
}

/** A topic of a forum supergroup. Its id is `message_thread_id`: the id of the message that created it. */
export interface SimTopic {
  id: number;
  name: string;
  iconColor: number;
  iconCustomEmojiId?: string;
  closed: boolean;
}

/** The thread id of "General" in a forum. Its messages carry no `message_thread_id`. */
export const GENERAL_TOPIC = 1;
/** The colors a topic icon may have (Bot API `createForumTopic`). */
export const TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];

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
  /**
   * Delay every API call by this much, to see loading indicators: a number of
   * milliseconds, or `[min, max]` for a random delay like a real network.
   * Default 0.
   */
  latencyMs?: number | [number, number];
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
  /** In a forum supergroup: the topic (`message_thread_id`); default "General". */
  thread?: number;
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
  /** The delay of every API call (see `SimulatorOptions.latencyMs`); can be changed any time. */
  latencyMs: number | [number, number];

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
  private readonly shippingQueries = new Map<string, (answer: ShippingAnswer) => void>();
  /** Successful payments by `telegram_payment_charge_id`, for `refundStarPayment`. */
  private readonly charges = new Map<string, { userId: number; currency: string; amount: number; payload: string; providerChargeId: string; refunded: boolean }>();
  /** `setMyName`, `setMyDescription`, `setMyShortDescription`, by kind and language. */
  private readonly botTexts = new Map<string, string>();
  /** `setMyDefaultAdministratorRights`, for groups and for channels. */
  private readonly defaultAdminRights = new Map<'groups' | 'channels', Record<string, boolean>>();
  private readonly stickerSets = new Map<string, StickerSet>();
  private readonly preparedButtons = new Map<string, { userId: number; button: KeyboardButton }>();
  /** Updates an API call caused (a member approved, a payment refunded), delivered after the call returns. */
  private readonly followUps: (() => Promise<void>)[] = [];
  /** Updates being delivered right now (follow-ups wait for them). */
  private delivering = 0;
  private nextLink = 1;
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
    this.emit('change', {});
    return full;
  }

  /** The first user: the one acting when no `user` is given. */
  get user(): User {
    return this.users.values().next().value!;
  }

  /** A group (a supergroup, like most groups today) with these members; the first user creates it and the bot is an admin. */
  createGroup(options: {
    title: string;
    members?: number[];
    admins?: number[];
    id?: number;
    type?: 'group' | 'supergroup';
    /** The bot is an admin (default true). */
    botAdmin?: boolean;
    /** A supergroup with topics (a forum). */
    forum?: boolean;
  }): SimChat {
    const id = options.id ?? -(1_000_000_000_000 + this.nextGroup++);
    const members = options.members ?? [this.user.id];
    const chat = this.newChat(id, options.forum ? 'supergroup' : (options.type ?? 'supergroup'), { title: options.title });
    if (options.forum) {
      chat.forum = true;
      chat.topics = [];
      chat.general = { name: 'General', closed: false, hidden: false };
      // Message 1 created the group, and "General" is thread 1: topics start after it.
      this.messageIds.set(id, Math.max(this.messageIds.get(id) ?? 0, 1));
    }
    members.forEach((userId, index) => {
      const status = index === 0 ? 'creator' : options.admins?.includes(userId) ? 'administrator' : 'member';
      chat.members.set(userId, { user: this.userOf(userId), status, rights: {} });
    });
    chat.members.set(this.botInfo.id, { user: this.botUser(), status: options.botAdmin === false ? 'member' : 'administrator', rights: {} });
    this.emit('change', { chatId: id });
    return chat;
  }

  /**
   * A channel: the owner (default: the first user) and admins post, the
   * subscribers read. The bot is an admin by default, so it can post. Posts
   * reach the bot as `channel_post` updates, without `from`.
   */
  createChannel(options: { title: string; owner?: number; subscribers?: number[]; admins?: number[]; id?: number; /** The bot is an admin (default true). */ botAdmin?: boolean }): SimChat {
    const id = options.id ?? -(1_000_000_000_000 + this.nextGroup++);
    const owner = options.owner ?? this.user.id;
    const chat = this.newChat(id, 'channel', { title: options.title });
    chat.members.set(owner, { user: this.userOf(owner), status: 'creator', rights: {} });
    for (const userId of options.admins ?? []) if (userId !== owner) chat.members.set(userId, { user: this.userOf(userId), status: 'administrator', rights: {} });
    for (const userId of options.subscribers ?? []) if (!chat.members.has(userId)) chat.members.set(userId, { user: this.userOf(userId), status: 'member', rights: {} });
    chat.members.set(this.botInfo.id, { user: this.botUser(), status: options.botAdmin === false ? 'member' : 'administrator', rights: {} });
    this.emit('change', { chatId: id });
    return chat;
  }

  /**
   * A user creates a topic in a forum supergroup: the bot gets the
   * `forum_topic_created` message, like on Telegram.
   */
  async createTopic(chatId: number, name: string, options: { user?: number; iconColor?: number } = {}): Promise<SimTopic> {
    const chat = this.chatFor(chatId);
    if (!chat.forum) throw new Error(`${chat.title ?? chatId} has no topics`);
    const iconColor = options.iconColor ?? TOPIC_COLORS[(chat.topics!.length) % TOPIC_COLORS.length]!;
    const message = await this.userMessage({ forum_topic_created: { name, icon_color: iconColor } } as Partial<Message>, { user: options.user, chat: chatId });
    return chat.topics!.find((t) => t.id === message.message.message_id)!;
  }

  /** A forum's topic by id ("General" is `GENERAL_TOPIC`). */
  topic(chatId: number, threadId: number): SimTopic | undefined {
    const chat = this.chats.get(chatId);
    if (!chat?.forum) return undefined;
    if (threadId === GENERAL_TOPIC) return { id: GENERAL_TOPIC, name: chat.general!.name, iconColor: TOPIC_COLORS[0]!, closed: chat.general!.closed };
    return chat.topics!.find((t) => t.id === threadId);
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
    await this.deliver((found.message.chat.type === 'channel' ? { edited_channel_post: found.message } : { edited_message: found.message }) as Omit<Update, 'update_id'>);
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

  /**
   * A user pays an invoice. Resolves with the bot's answer; on success a
   * `successful_payment` message follows. For an invoice with `is_flexible`
   * the bot first gets a `shipping_query` (to the `shippingAddress` given, or
   * a default one) and the user picks `shippingOption` (default: the first the
   * bot offered). `need_name`, `need_phone_number`, `need_email` and
   * `need_shipping_address` fill `order_info`.
   */
  async pay(messageId: number, options: SendOptions & { shippingAddress?: Partial<ShippingAddress>; shippingOption?: string } = {}): Promise<{ ok: boolean; error?: string }> {
    const userId = options.user ?? this.user.id;
    const found = this.findMessage(options.chat ?? userId, messageId) as InvoiceMessage | undefined;
    const invoice = found?.message.invoice;
    if (!found || !invoice) throw new Error(`Message ${messageId} is not an invoice`);
    const payload = found.invoicePayload ?? '';
    const needs = found.invoiceNeeds ?? {};
    const user = this.userOf(userId);
    const chatId = found.message.chat.id;
    const fail = (answer: { ok: boolean; error?: string }) => {
      this.emit('toast', { chatId, userId, text: answer.error ?? 'Payment failed', alert: true });
      return answer;
    };
    const address = needs.shipping || needs.flexible ? { ...DEFAULT_ADDRESS, ...options.shippingAddress } : undefined;
    let total = invoice.total_amount;
    let shippingOptionId: string | undefined;
    if (needs.flexible) {
      const id = String(this.nextQuery++);
      const answered = new Promise<ShippingAnswer>((resolve) => this.shippingQueries.set(id, resolve));
      await this.deliver({ shipping_query: { id, from: user, invoice_payload: payload, shipping_address: address! } } as Omit<Update, 'update_id'>);
      const answer = await Promise.race([answered, Promise.resolve<ShippingAnswer>({ ok: false, error: 'The bot did not answer' })]);
      this.shippingQueries.delete(id);
      if (!answer.ok) return fail({ ok: false, error: answer.error });
      const option = options.shippingOption === undefined ? answer.options![0] : answer.options!.find((o) => o.id === options.shippingOption);
      if (!option) throw new Error(`The bot offered no shipping option ${options.shippingOption}`);
      shippingOptionId = option.id;
      total += option.prices.reduce((sum, price) => sum + price.amount, 0);
    }
    const orderInfo = {
      ...(needs.name ? { name: [user.first_name, user.last_name].filter(Boolean).join(' ') } : {}),
      ...(needs.phone ? { phone_number: '+10000000000' } : {}),
      ...(needs.email ? { email: `user${userId}@example.com` } : {}),
      ...(address ? { shipping_address: address } : {}),
    };
    const extra = { ...(shippingOptionId ? { shipping_option_id: shippingOptionId } : {}), ...(Object.keys(orderInfo).length ? { order_info: orderInfo } : {}) };
    const id = String(this.nextQuery++);
    const answered = new Promise<{ ok: boolean; error?: string }>((resolve) => this.preCheckouts.set(id, resolve));
    await this.deliver({
      pre_checkout_query: { id, from: user, currency: invoice.currency, total_amount: total, invoice_payload: payload, ...extra },
    } as Omit<Update, 'update_id'>);
    const answer = await Promise.race([answered, Promise.resolve({ ok: false, error: 'The bot did not answer' })]);
    this.preCheckouts.delete(id);
    if (!answer.ok) return fail(answer);
    const charge = `sim_${id}`;
    this.charges.set(charge, { userId, currency: invoice.currency, amount: total, payload, providerChargeId: `sim_provider_${id}`, refunded: false });
    await this.userMessage(
      {
        successful_payment: {
          currency: invoice.currency,
          total_amount: total,
          invoice_payload: payload,
          telegram_payment_charge_id: charge,
          provider_payment_charge_id: `sim_provider_${id}`,
          ...extra,
        },
      },
      { ...options, user: userId, chat: chatId },
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
    if (chat.type === 'channel') {
      this.emit('change', { chatId }); // subscribers join quietly
      return undefined;
    }
    return this.userMessage({ new_chat_members: [user] }, { chat: chatId, user: userId });
  }

  /** A user leaves a group. */
  async leave(chatId: number, userId: number) {
    const chat = this.chatFor(chatId);
    const member = chat.members.get(userId);
    if (member) member.status = 'left';
    if (chat.type === 'channel') {
      this.emit('change', { chatId });
      return undefined;
    }
    return this.userMessage({ left_chat_member: this.userOf(userId) }, { chat: chatId, user: userId });
  }

  /**
   * A user asks to join a supergroup or channel: the bot gets a
   * `chat_join_request` and decides with `approveChatJoinRequest` (the user
   * joins) or `declineChatJoinRequest`. Until then, and for 5 minutes at most,
   * the bot may write to the user (`user_chat_id`). `inviteLink`: the link
   * used (one the bot made). `query`: the request carries a `query_id`, to be
   * answered within 10 seconds with `answerChatJoinRequestQuery` or
   * `sendChatJoinRequestWebApp`.
   */
  async requestToJoin(chatId: number, userId: number, options: { inviteLink?: string; bio?: string; query?: boolean } = {}): Promise<SimJoinRequest> {
    const chat = this.chatFor(chatId);
    if (chat.type !== 'supergroup' && chat.type !== 'channel') throw new Error('Join requests are for supergroups and channels');
    const user = this.userOf(userId);
    const status = chat.members.get(userId)?.status;
    if (status === 'kicked') throw new Error(`User ${userId} is banned from ${chat.title ?? chat.id}`);
    if (status && status !== 'left') throw new Error(`User ${userId} is already a member of ${chat.title ?? chat.id}`);
    const link = options.inviteLink === undefined ? undefined : chat.inviteLinks?.find((l) => l.invite_link === options.inviteLink);
    if (options.inviteLink !== undefined && !link) throw new Error(`No invite link ${options.inviteLink} in ${chat.title ?? chat.id}`);
    const request: SimJoinRequest = {
      userId,
      date: now(),
      ...(link ? { inviteLink: link.invite_link } : {}),
      ...(options.bio ? { bio: options.bio } : {}),
      ...(options.query ? { queryId: String(this.nextQuery++) } : {}),
    };
    (chat.joinRequests ??= new Map()).set(userId, request);
    this.privateChat(userId);
    this.emit('change', { chatId: chat.id });
    await this.deliver({
      chat_join_request: {
        chat: this.chatObject(chat),
        from: user,
        user_chat_id: userId,
        date: request.date,
        ...(request.bio ? { bio: request.bio } : {}),
        ...(link ? { invite_link: this.linkObject(chat, link) } : {}),
        ...(request.queryId ? { query_id: request.queryId } : {}),
      },
    } as Omit<Update, 'update_id'>);
    return request;
  }

  /**
   * A user opens an invite link the bot made: they join the chat, or, for a
   * link with `creates_join_request`, ask to join (`requestToJoin`). Throws
   * for links that are revoked, expired or full, which Telegram's apps refuse.
   */
  async joinByLink(inviteLink: string, userId = this.user.id): Promise<SimMessage | SimJoinRequest | undefined> {
    for (const chat of this.chats.values()) {
      const link = chat.inviteLinks?.find((l) => l.invite_link === inviteLink);
      if (!link) continue;
      if (link.is_revoked || (link.expire_date !== undefined && link.expire_date <= now())) throw new Error(`The invite link ${inviteLink} has expired`);
      if (link.creates_join_request) return this.requestToJoin(chat.id, userId, { inviteLink });
      const status = chat.members.get(userId)?.status;
      if (status === 'kicked') throw new Error(`User ${userId} is banned from ${chat.title ?? chat.id}`);
      if (status && status !== 'left') throw new Error(`User ${userId} is already a member of ${chat.title ?? chat.id}`);
      if (link.member_limit !== undefined && link.joined.filter((id) => isIn(chat, id)).length >= link.member_limit) {
        throw new Error(`The invite link ${inviteLink} has reached its member limit`);
      }
      link.joined.push(userId);
      return this.join(chat.id, userId);
    }
    throw new Error(`No invite link ${inviteLink}`);
  }

  /**
   * A user reacts to a message with emoji (an empty list takes their reaction
   * back): the bot gets a `message_reaction` update.
   */
  async react(messageId: number, reaction: string | string[], options: { user?: number; chat?: number } = {}): Promise<void> {
    const userId = options.user ?? this.user.id;
    const chat = this.chatFor(options.chat ?? userId);
    const found = this.findMessage(chat.id, messageId);
    if (!found || !visibleTo([found], userId).length) throw new Error(`No message ${messageId} in chat ${chat.title ?? chat.id}`);
    if (chat.type !== 'private' && !isIn(chat, userId)) throw new Error(`User ${userId} is not a member of ${chat.title ?? chat.id}`);
    const next = (Array.isArray(reaction) ? reaction : [reaction]).map((emoji) => ({ type: 'emoji', emoji }) as ReactionType);
    const old = found.reactions?.find((r) => r.user === userId)?.reaction ?? [];
    found.reactions = [...(found.reactions ?? []).filter((r) => r.user !== userId), ...(next.length ? [{ user: userId, reaction: next }] : [])];
    this.emit('change', { chatId: chat.id });
    await this.deliver({
      message_reaction: { chat: this.chatObject(chat), message_id: messageId, user: this.userOf(userId), date: now(), old_reaction: old, new_reaction: next },
    } as Omit<Update, 'update_id'>);
  }

  /**
   * A sticker set that exists on this Telegram (the simulator knows none
   * otherwise), for `getStickerSet`, `getCustomEmojiStickers` and
   * `setChatStickerSet`: one sticker per emoji, whose file ids `sendSticker`
   * accepts.
   */
  addStickerSet(set: { name: string; title?: string; type?: StickerSet['sticker_type']; emojis?: string[] }): StickerSet {
    const type = set.type ?? 'regular';
    const stickers = (set.emojis ?? ['🙂']).map((emoji) => {
      const fileId = this.registerFile({ kind: 'sticker', name: `${emoji}.webp` });
      return {
        file_id: fileId,
        file_unique_id: fileId,
        type,
        width: type === 'custom_emoji' ? 100 : 512,
        height: type === 'custom_emoji' ? 100 : 512,
        is_animated: false,
        is_video: false,
        emoji,
        set_name: set.name,
        ...(type === 'custom_emoji' ? { custom_emoji_id: String(5_000_000_000_000_000_000 + this.nextFile++) } : {}),
      } as Sticker;
    });
    const full: StickerSet = { name: set.name, title: set.title ?? set.name, sticker_type: type, stickers };
    this.stickerSets.set(set.name, full);
    return full;
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
    const admin = member?.status === 'creator' || member?.status === 'administrator';
    if (member?.status === 'member' && chat.permissions?.can_send_messages === false && !fields.new_chat_members && !fields.left_chat_member && !fields.forum_topic_created) {
      throw new Error(`Members can't send messages in ${chat.title ?? chat.id}`);
    }
    if (chat.type === 'channel' && !admin) throw new Error(`User ${userId} can't post in the channel ${chat.title ?? chat.id}: only its owner and admins can`);
    if (fields.forum_topic_created && !chat.forum) throw new Error(`${chat.title ?? chat.id} has no topics`);
    // A topic of a forum: given, or the one of the message replied to.
    let thread = options.thread;
    if (thread === undefined && options.replyTo !== undefined && chat.forum) {
      const replied = this.findMessage(chat.id, options.replyTo)?.message;
      if (replied?.is_topic_message) thread = replied.message_thread_id;
    }
    if (thread !== undefined && thread !== GENERAL_TOPIC) {
      if (!chat.forum) throw new Error(`${chat.title ?? chat.id} has no topics`);
      const topic = chat.topics!.find((t) => t.id === thread);
      if (!topic) throw new Error(`No topic ${thread} in ${chat.title ?? chat.id}`);
      if (topic.closed && !admin) throw new Error(`The topic "${topic.name}" is closed`);
      fields = { ...fields, message_thread_id: thread, is_topic_message: true } as Partial<Message>;
    } else if (thread === GENERAL_TOPIC && chat.general?.closed && !admin) {
      throw new Error('The topic "General" is closed');
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
    await this.deliver((chat.type === 'channel' ? { channel_post: message.message } : { message: message.message }) as Omit<Update, 'update_id'>);
    return message;
  }

  private async deliver(update: Omit<Update, 'update_id'>) {
    this.delivering++;
    try {
      await this.handOut(update);
    } finally {
      this.delivering--;
    }
    // What the bot's calls caused (a member it approved joins) is delivered before the user's action resolves.
    while (this.followUps.length) await this.followUps.shift()!();
  }

  private async handOut(update: Omit<Update, 'update_id'>) {
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
    } else {
      try {
        if (!bot.isInited()) await bot.init();
        await bot.handleUpdate(full);
      } catch (error) {
        this.emit('error', { error });
        if (!this.listeners.get('error')?.size) throw error;
      }
    }
  }

  /**
   * Deliver an update an API call caused, after the update being handled (the
   * bot may be waiting for its call); right away when nothing is being handled.
   */
  private followUp(update: Omit<Update, 'update_id'>) {
    if (this.delivering) {
      this.followUps.push(() => this.deliver(update));
      return;
    }
    void Promise.resolve()
      .then(() => this.deliver(update))
      .catch((error) => this.emit('error', { error }));
  }

  private open(url: string, kind: SimEvents['open']['kind'], chatId: number | undefined, userId: number): SimCallbackAnswer {
    this.emit('open', { url, kind, chatId, userId });
    return { url };
  }

  /* ------------------------------ Bot API ------------------------------ */

  private async call(method: string, payload: Record<string, any>, signal?: AbortSignal): Promise<ApiResult> {
    if (method !== 'getUpdates') {
      const [min, max] = Array.isArray(this.latencyMs) ? this.latencyMs : [this.latencyMs, this.latencyMs];
      const delay = min + Math.random() * Math.max(0, max - min);
      if (delay > 0) await sleep(delay);
    }
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

    sendLocation: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id);
      const location = this.location(p);
      const live = p.live_period !== undefined;
      if (live && !(p.live_period === LIVE_FOREVER || (p.live_period >= 60 && p.live_period <= 86400))) throw badRequest('LIVE_PERIOD_INVALID');
      const sent = this.botMessage(chat, p, { location: live ? { ...location, live_period: p.live_period as number } : stripLive(location) });
      if (live) sent.liveUntil = p.live_period === LIVE_FOREVER ? Infinity : sent.message.date + p.live_period;
      return sent.message;
    },
    sendVenue: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id);
      const location = stripLive(this.location(p));
      if (!p.title || !String(p.title).trim()) throw badRequest('venue title is empty');
      if (!p.address || !String(p.address).trim()) throw badRequest('venue address is empty');
      const optional = ['foursquare_id', 'foursquare_type', 'google_place_id', 'google_place_type'].filter((k) => p[k] !== undefined).map((k) => [k, p[k]]);
      const venue = { location, title: String(p.title), address: String(p.address), ...Object.fromEntries(optional) };
      return this.botMessage(chat, p, { venue, location } as Partial<Message>).message;
    },
    editMessageLiveLocation: (p: Record<string, any>) => {
      const found = this.liveLocation(p);
      const location = this.location(p);
      const period = p.live_period ?? found.message.location!.live_period;
      if (p.live_period !== undefined) {
        if (!(p.live_period === LIVE_FOREVER || p.live_period >= 60)) throw badRequest('LIVE_PERIOD_INVALID');
        const until = p.live_period === LIVE_FOREVER ? Infinity : found.message.date + (p.live_period as number);
        if (until <= now()) throw badRequest('LIVE_PERIOD_INVALID');
        found.liveUntil = until;
      }
      const next = { ...location, live_period: period };
      return this.applyEdit(found, p, { location: next } as Partial<Message>, () => same(found.message.location, next));
    },
    stopMessageLiveLocation: (p: Record<string, any>) => {
      const found = this.liveLocation(p);
      found.liveUntil = undefined;
      return this.applyEdit(found, p, { location: stripLive(found.message.location!) } as Partial<Message>, () => false);
    },
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
      const invoiceMessage = sent as InvoiceMessage;
      invoiceMessage.invoicePayload = p.payload;
      // Stars invoices have no shipping (Telegram ignores the flags).
      const stars = p.currency === 'XTR';
      invoiceMessage.invoiceNeeds = {
        flexible: !stars && !!p.is_flexible,
        shipping: !stars && !!p.need_shipping_address,
        name: !stars && !!p.need_name,
        phone: !stars && !!p.need_phone_number,
        email: !stars && !!p.need_email,
      };
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
      const group = chat.type === 'group' || chat.type === 'supergroup';
      const primary = chat.inviteLinks?.find((l) => l.is_primary && !l.is_revoked);
      const pinned = chat.pinned.length ? this.findMessage(chat.id, chat.pinned.at(-1)!) : undefined;
      const botStatus = chat.members.get(this.botInfo.id)?.status;
      return {
        ...this.chatObject(chat),
        accent_color_id: 0,
        max_reaction_count: 11,
        ...(chat.photo ? { photo: chatPhoto(chat.photo.fileId) } : {}),
        ...(chat.description ? { description: chat.description } : {}),
        ...(primary ? { invite_link: primary.invite_link } : {}),
        ...(pinned ? { pinned_message: pinned.message } : {}),
        ...(group ? { permissions: chat.permissions ?? allPermissions() } : {}),
        ...(chat.stickerSet ? { sticker_set_name: chat.stickerSet } : {}),
        ...(chat.type === 'supergroup' && (botStatus === 'administrator' || botStatus === 'creator') ? { can_set_sticker_set: true } : {}),
      };
    },
    getChatMember: (p: Record<string, any>) => this.memberObject(this.target(p.chat_id, true), p.user_id),

    // Forum topics
    getForumTopicIconStickers: () => [],
    createForumTopic: (p: Record<string, any>) => {
      const chat = this.forumOf(p);
      if (!p.name || String(p.name).length > 128) throw badRequest('TOPIC_TITLE_EMPTY');
      const iconColor = p.icon_color ?? TOPIC_COLORS[0];
      if (!TOPIC_COLORS.includes(iconColor)) throw badRequest('TOPIC_ICON_COLOR_INVALID');
      const created = { name: String(p.name), icon_color: iconColor, ...(p.icon_custom_emoji_id ? { icon_custom_emoji_id: p.icon_custom_emoji_id } : {}) };
      const sent = this.push(chat, this.botUser(), { forum_topic_created: created } as Partial<Message>, true);
      return { message_thread_id: sent.message.message_id, ...created };
    },
    editForumTopic: (p: Record<string, any>) => {
      const topic = this.topicOf(p);
      const edited: Record<string, unknown> = {};
      if (p.name !== undefined) edited.name = topic.name = String(p.name);
      if (p.icon_custom_emoji_id !== undefined) edited.icon_custom_emoji_id = topic.iconCustomEmojiId = p.icon_custom_emoji_id || undefined;
      this.push(this.forumOf(p), this.botUser(), { forum_topic_edited: edited, message_thread_id: topic.id, is_topic_message: true } as Partial<Message>, true);
      return true;
    },
    closeForumTopic: (p: Record<string, any>) => this.setTopicClosed(p, true),
    reopenForumTopic: (p: Record<string, any>) => this.setTopicClosed(p, false),
    deleteForumTopic: (p: Record<string, any>) => {
      const chat = this.forumOf(p);
      const topic = this.topicOf(p);
      chat.topics = chat.topics!.filter((t) => t !== topic);
      chat.messages = chat.messages.filter((m) => !(m.message.is_topic_message && m.message.message_thread_id === topic.id));
      this.emit('change', { chatId: chat.id });
      return true;
    },
    unpinAllForumTopicMessages: (p: Record<string, any>) => (this.topicOf(p), true),
    editGeneralForumTopic: (p: Record<string, any>) => {
      const chat = this.forumOf(p);
      chat.general!.name = String(p.name);
      this.emit('change', { chatId: chat.id });
      return true;
    },
    closeGeneralForumTopic: (p: Record<string, any>) => this.setGeneral(p, { closed: true }),
    reopenGeneralForumTopic: (p: Record<string, any>) => this.setGeneral(p, { closed: false }),
    hideGeneralForumTopic: (p: Record<string, any>) => this.setGeneral(p, { hidden: true, closed: true }),
    unhideGeneralForumTopic: (p: Record<string, any>) => this.setGeneral(p, { hidden: false }),
    unpinAllGeneralForumTopicMessages: (p: Record<string, any>) => (this.forumOf(p), true),
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
      const reaction = (p.reaction ?? []) as ReactionType[];
      found.reactions = [...(found.reactions ?? []).filter((r) => r.user !== this.botInfo.id), ...(reaction.length ? [{ user: this.botInfo.id, reaction }] : [])];
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
    setMyName: (p: Record<string, any>) => this.setBotText('name', p.name, p.language_code, 64),
    getMyName: (p: Record<string, any>) => ({ name: this.botText('name', p.language_code) ?? this.botInfo.first_name }),
    setMyDescription: (p: Record<string, any>) => this.setBotText('description', p.description, p.language_code, 512),
    getMyDescription: (p: Record<string, any>) => ({ description: this.botText('description', p.language_code) ?? '' }),
    setMyShortDescription: (p: Record<string, any>) => this.setBotText('short_description', p.short_description, p.language_code, 120),
    getMyShortDescription: (p: Record<string, any>) => ({ short_description: this.botText('short_description', p.language_code) ?? '' }),
    setMyDefaultAdministratorRights: (p: Record<string, any>) => {
      const key = p.for_channels ? 'channels' : 'groups';
      if (p.rights === undefined) this.defaultAdminRights.delete(key);
      else this.defaultAdminRights.set(key, Object.fromEntries(Object.entries(p.rights as Record<string, unknown>).map(([k, v]) => [k, !!v])));
      return true;
    },
    getMyDefaultAdministratorRights: (p: Record<string, any>) => {
      const channels = !!p.for_channels;
      const rights = this.defaultAdminRights.get(channels ? 'channels' : 'groups') ?? {};
      const names = [...ADMIN_RIGHTS, ...(channels ? ['can_post_messages', 'can_edit_messages'] : ['can_pin_messages', 'can_manage_topics', 'can_manage_tags'])];
      return Object.fromEntries(names.map((name) => [name, rights[name] ?? false]));
    },

    getFile: (p: Record<string, any>) => {
      const file = this.files.get(p.file_id);
      if (!file) throw badRequest('invalid file_id');
      return { file_id: p.file_id, file_unique_id: p.file_id, file_size: this.fileData.get(p.file_id)?.size ?? 1024, file_path: `${file.kind}/${p.file_id}` };
    },
    getUserProfilePhotos: () => ({ total_count: 0, photos: [] }),

    // Polls
    stopPoll: (p: Record<string, any>) => {
      const chat = this.target(p.chat_id, true);
      const found = this.findMessage(chat.id, p.message_id);
      if (!found?.message.poll) throw badRequest('message with poll to stop not found');
      if (!found.fromBot) throw badRequest("message can't be edited");
      if (found.message.poll.is_closed) throw badRequest('poll has already been closed');
      const markup = p.reply_markup?.inline_keyboard ? (p.reply_markup as InlineKeyboardMarkup) : undefined;
      this.checkMarkup(markup);
      const poll = { ...found.message.poll, is_closed: true };
      found.message = { ...found.message, poll, ...(markup ? { reply_markup: markup } : {}) } as Message;
      this.emit('change', { chatId: chat.id });
      return poll;
    },

    // Payments
    answerShippingQuery: (p: Record<string, any>) => {
      const resolve = this.shippingQueries.get(String(p.shipping_query_id));
      if (!resolve) throw badRequest('query is too old and response timeout expired or query ID is invalid');
      if (p.ok) {
        const options = p.shipping_options as { id: string; title: string; prices: { label: string; amount: number }[] }[] | undefined;
        if (!Array.isArray(options) || !options.length) throw badRequest('SHIPPING_OPTIONS_EMPTY');
        for (const option of options) {
          if (!option.id || !option.title || !Array.isArray(option.prices) || !option.prices.length) throw badRequest('SHIPPING_OPTION_INVALID');
        }
        resolve({ ok: true, options });
      } else {
        if (!p.error_message) throw badRequest('error_message is required if ok is False');
        resolve({ ok: false, error: p.error_message });
      }
      this.shippingQueries.delete(String(p.shipping_query_id));
      return true;
    },
    createInvoiceLink: (p: Record<string, any>) => {
      if (!p.title || String(p.title).length > 32) throw badRequest('INVOICE_TITLE_INVALID');
      if (!p.description || String(p.description).length > 255) throw badRequest('INVOICE_DESCRIPTION_INVALID');
      if (!p.payload || new TextEncoder().encode(String(p.payload)).length > 128) throw badRequest('INVOICE_PAYLOAD_INVALID');
      const prices = p.prices as { label: string; amount: number }[] | undefined;
      if (!Array.isArray(prices) || !prices.length) throw badRequest('INVOICE_PRICES_EMPTY'); // the simulator's wording
      if (p.currency === 'XTR' && prices.length !== 1) throw badRequest('STARS_INVOICE_INVALID');
      if (p.subscription_period !== undefined && (p.currency !== 'XTR' || p.subscription_period !== 2592000)) throw badRequest('SUBSCRIPTION_PERIOD_INVALID');
      return `https://t.me/$${this.slug()}`;
    },
    refundStarPayment: (p: Record<string, any>) => {
      const charge = this.charges.get(String(p.telegram_payment_charge_id));
      if (!charge || charge.currency !== 'XTR' || charge.userId !== p.user_id) throw badRequest('CHARGE_NOT_FOUND');
      if (charge.refunded) throw badRequest('CHARGE_ALREADY_REFUNDED');
      charge.refunded = true;
      // The user's chat shows the refund, and the bot gets it as a message.
      const chat = this.privateChat(charge.userId);
      const refunded = {
        currency: charge.currency,
        total_amount: charge.amount,
        invoice_payload: charge.payload,
        telegram_payment_charge_id: String(p.telegram_payment_charge_id),
        provider_payment_charge_id: charge.providerChargeId,
      };
      const message = this.push(chat, this.userOf(charge.userId), { refunded_payment: refunded } as Partial<Message>, false);
      this.followUp({ message: message.message } as Omit<Update, 'update_id'>);
      return true;
    },

    // Reactions
    deleteMessageReaction: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_delete_messages', 'delete reactions', ['group', 'supergroup']);
      const found = this.findMessage(chat.id, p.message_id);
      if (!found) throw badRequest('MESSAGE_ID_INVALID');
      if (p.user_id === undefined && p.actor_chat_id === undefined) throw badRequest('user_id or actor_chat_id must be specified');
      found.reactions = found.reactions?.filter((r) => !reactedBy(r, p));
      this.emit('change', { chatId: chat.id });
      return true;
    },
    deleteAllMessageReactions: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_delete_messages', 'delete reactions', ['group', 'supergroup']);
      if (p.user_id === undefined && p.actor_chat_id === undefined) throw badRequest('user_id or actor_chat_id must be specified');
      for (const message of chat.messages) if (message.reactions) message.reactions = message.reactions.filter((r) => !reactedBy(r, p));
      this.emit('change', { chatId: chat.id });
      return true;
    },

    // Stickers (sets come from sim.addStickerSet)
    getStickerSet: (p: Record<string, any>) => {
      const set = this.stickerSets.get(String(p.name));
      if (!set) throw badRequest('STICKERSET_INVALID');
      return set;
    },
    getCustomEmojiStickers: (p: Record<string, any>) => {
      const ids = p.custom_emoji_ids as string[] | undefined;
      if (!Array.isArray(ids) || ids.length > 200) throw badRequest('custom_emoji_ids must be a list of at most 200 identifiers');
      const all = [...this.stickerSets.values()].flatMap((set) => set.stickers);
      return ids.map((id) => all.find((s) => s.custom_emoji_id === String(id))).filter((s): s is Sticker => !!s);
    },

    savePreparedKeyboardButton: (p: Record<string, any>) => {
      if (!this.users.has(p.user_id)) throw badRequest('user not found');
      const button = p.button as KeyboardButton | undefined;
      if (!button || typeof button !== 'object' || !['request_users', 'request_chat', 'request_managed_bot'].some((k) => k in button)) {
        throw badRequest('button must be of the type request_users, request_chat or request_managed_bot');
      }
      if (!button.text) throw badRequest('button text is empty');
      const id = `prepared-button-${this.nextQuery++}`;
      this.preparedButtons.set(id, { userId: p.user_id, button });
      return { id };
    },

    // Chat settings
    setChatTitle: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_change_info', 'change chat title');
      const title = String(p.title ?? '').trim();
      if (!title) throw badRequest('chat title is empty');
      if (title.length > 128) throw badRequest('chat title is too long'); // the simulator's wording
      if (title === chat.title) throw badRequest('chat title is not modified');
      chat.title = title;
      this.push(chat, this.botUser(), { new_chat_title: title } as Partial<Message>, true);
      return true;
    },
    setChatDescription: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_change_info', 'change chat description');
      const description = String(p.description ?? '');
      if (description.length > 255) throw badRequest('chat description is too long');
      if (description === (chat.description ?? '')) throw badRequest('chat description is not modified');
      chat.description = description || undefined;
      this.emit('change', { chatId: chat.id });
      return true;
    },
    setChatPhoto: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_change_info', 'change chat photo');
      // A new photo must be uploaded; file ids and URLs aren't accepted.
      if (p.photo === undefined || typeof p.photo === 'string') throw badRequest('there is no photo in the request');
      const media = this.mediaFrom('photo', p.photo, p.photo?.filename);
      const fields = this.mediaFields('photo', media);
      const fileId = fields.photo!.at(-1)!.file_id;
      chat.photo = { fileId, url: media.url };
      this.push(chat, this.botUser(), { new_chat_photo: fields.photo } as Partial<Message>, true, media);
      return true;
    },
    deleteChatPhoto: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_change_info', 'change chat photo');
      if (!chat.photo) throw badRequest('CHAT_NOT_MODIFIED');
      chat.photo = undefined;
      this.push(chat, this.botUser(), { delete_chat_photo: true } as Partial<Message>, true);
      return true;
    },
    setChatPermissions: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_restrict_members', 'change chat permissions', ['group', 'supergroup']);
      const given = p.permissions as Record<string, unknown> | undefined;
      if (!given || typeof given !== 'object') throw badRequest('permissions must be an object');
      const permissions = Object.fromEntries(PERMISSIONS.map((name) => [name, !!given[name]])) as Record<string, boolean>;
      if (!p.use_independent_chat_permissions) {
        // Telegram's implications for chats that don't set them independently.
        if (permissions.can_send_other_messages || permissions.can_add_web_page_previews) {
          for (const name of ['can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes']) permissions[name] = true;
        }
        if (permissions.can_send_polls) permissions.can_send_messages = true;
      }
      if (given.can_react_to_messages === undefined) permissions.can_react_to_messages = permissions.can_send_messages!;
      if (given.can_manage_topics === undefined) permissions.can_manage_topics = permissions.can_pin_messages!;
      if (given.can_edit_tag === undefined) permissions.can_edit_tag = permissions.can_pin_messages!;
      chat.permissions = permissions as ChatPermissions;
      this.emit('change', { chatId: chat.id });
      return true;
    },
    setChatAdministratorCustomTitle: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_promote_members', 'change custom title', ['supergroup']);
      const member = chat.members.get(p.user_id);
      if (!member || (member.status !== 'administrator' && member.status !== 'creator')) throw badRequest('user is not an administrator');
      const title = String(p.custom_title ?? '');
      if (title.length > 16) throw badRequest('ADMIN_RANK_INVALID');
      if (EMOJI.test(title)) throw badRequest('ADMIN_RANK_EMOJI_NOT_ALLOWED');
      member.customTitle = title || undefined;
      this.emit('change', { chatId: chat.id });
      return true;
    },
    setChatMemberTag: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_manage_tags', 'manage tags', ['group', 'supergroup']);
      const member = chat.members.get(p.user_id);
      if (!member || member.status === 'left' || member.status === 'kicked') throw badRequest('USER_NOT_PARTICIPANT');
      if (member.status !== 'member' && member.status !== 'restricted') throw badRequest('tags can be set only for regular members');
      const tag = String(p.tag ?? '');
      if (tag.length > 16) throw badRequest('TAG_INVALID');
      if (EMOJI.test(tag)) throw badRequest('TAG_EMOJI_NOT_ALLOWED');
      member.tag = tag || undefined;
      this.emit('change', { chatId: chat.id });
      return true;
    },
    banChatSenderChat: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_restrict_members', 'restrict/unrestrict chat member', ['supergroup', 'channel']);
      if (!Number.isInteger(p.sender_chat_id)) throw badRequest('sender_chat_id must be an integer');
      if (p.sender_chat_id === chat.id) throw badRequest("can't ban the chat itself");
      chat.bannedSenderChats = [...new Set([...(chat.bannedSenderChats ?? []), p.sender_chat_id as number])];
      return true;
    },
    unbanChatSenderChat: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_restrict_members', 'restrict/unrestrict chat member', ['supergroup', 'channel']);
      chat.bannedSenderChats = chat.bannedSenderChats?.filter((id) => id !== p.sender_chat_id);
      return true;
    },
    setChatStickerSet: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_change_info', 'change chat sticker set', ['supergroup']);
      if (!this.stickerSets.has(String(p.sticker_set_name))) throw badRequest('STICKERSET_INVALID');
      chat.stickerSet = String(p.sticker_set_name);
      this.emit('change', { chatId: chat.id });
      return true;
    },
    deleteChatStickerSet: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_change_info', 'change chat sticker set', ['supergroup']);
      chat.stickerSet = undefined;
      this.emit('change', { chatId: chat.id });
      return true;
    },
    getUserChatBoosts: (p: Record<string, any>) => {
      this.manage(p, undefined, 'get boosts', ['supergroup', 'channel']);
      if (!this.users.has(p.user_id)) throw badRequest('user not found');
      return { boosts: [] }; // nobody boosts chats in the simulator
    },

    // Invite links
    exportChatInviteLink: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage chat invite link');
      return this.newPrimaryLink(chat).invite_link;
    },
    createChatInviteLink: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage chat invite link');
      const link = this.newLink(chat, { is_primary: false, creates_join_request: !!p.creates_join_request });
      this.editLink(link, p);
      return this.linkObject(chat, link);
    },
    editChatInviteLink: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage chat invite link');
      const link = this.botLink(chat, p.invite_link);
      if (link.is_primary) throw badRequest("primary invite link can't be edited");
      if (link.subscription_period !== undefined) throw badRequest('use editChatSubscriptionInviteLink for subscription links');
      this.editLink(link, p);
      return this.linkObject(chat, link);
    },
    revokeChatInviteLink: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage chat invite link');
      const link = this.botLink(chat, p.invite_link);
      if (link.is_primary) this.newPrimaryLink(chat); // revokes this one and makes the next
      else link.is_revoked = true;
      return this.linkObject(chat, link);
    },
    createChatSubscriptionInviteLink: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage chat invite link', ['channel']);
      if (p.subscription_period !== 2592000) throw badRequest('SUBSCRIPTION_PERIOD_INVALID');
      if (!Number.isInteger(p.subscription_price) || p.subscription_price < 1 || p.subscription_price > 2500) throw badRequest('SUBSCRIPTION_PRICE_INVALID');
      const link = this.newLink(chat, { is_primary: false, creates_join_request: false, subscription_period: p.subscription_period, subscription_price: p.subscription_price });
      this.editLink(link, { name: p.name });
      return this.linkObject(chat, link);
    },
    editChatSubscriptionInviteLink: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage chat invite link', ['channel']);
      const link = this.botLink(chat, p.invite_link);
      if (link.subscription_period === undefined) throw badRequest('the link is not a subscription link');
      this.editLink(link, { name: p.name });
      return this.linkObject(chat, link);
    },

    // Join requests
    approveChatJoinRequest: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage join requests', ['supergroup', 'channel']);
      const request = this.joinRequest(chat, p.user_id);
      if (isIn(chat, p.user_id)) throw badRequest('USER_ALREADY_PARTICIPANT');
      this.admit(chat, request);
      return true;
    },
    declineChatJoinRequest: (p: Record<string, any>) => {
      const chat = this.manage(p, 'can_invite_users', 'manage join requests', ['supergroup', 'channel']);
      this.joinRequest(chat, p.user_id);
      chat.joinRequests!.delete(p.user_id);
      this.emit('change', { chatId: chat.id });
      return true;
    },
    answerChatJoinRequestQuery: (p: Record<string, any>) => {
      if (!['approve', 'decline', 'queue'].includes(p.result)) throw badRequest('result must be one of "approve", "decline" or "queue"');
      const { chat, request } = this.joinQuery(p.chat_join_request_query_id);
      request.queryId = undefined;
      if (p.result === 'approve') this.admit(chat, request);
      else if (p.result === 'decline') chat.joinRequests!.delete(request.userId);
      this.emit('change', { chatId: chat.id });
      return true;
    },
    sendChatJoinRequestWebApp: (p: Record<string, any>) => {
      const { request } = this.joinQuery(p.chat_join_request_query_id);
      if (typeof p.web_app_url !== 'string' || !p.web_app_url.startsWith('https://')) throw badRequest('WEBAPP_URL_INVALID');
      request.queryId = undefined; // the Mini App decides now; the bot approves or declines later
      this.open(p.web_app_url, 'webApp', request.userId, request.userId);
      return true;
    },
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
      if (!chat.started && !any && !this.askedToJoin(chat.id)) throw new ApiError(403, "Forbidden: bot can't initiate conversation with a user");
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
    return { id: chat.id, type: chat.type, title: chat.title ?? '', ...(chat.forum ? { is_forum: true } : {}) } as Chat;
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
      const title = member.customTitle ? { custom_title: member.customTitle } : {};
      return { status, user, is_anonymous: false, ...Object.fromEntries(all.map((r) => [r, rights[r] ?? true])), ...title } as ChatMember;
    }
    const tag = member.tag ? { tag: member.tag } : {};
    if (status === 'restricted') return { status, user, is_member: true, until_date: member.until ?? 0, ...rights, ...tag } as ChatMember;
    if (status === 'kicked') return { status, user, until_date: member.until ?? 0 } as ChatMember;
    if (status === 'creator') return { status, user, is_anonymous: false, ...(member.customTitle ? { custom_title: member.customTitle } : {}) } as ChatMember;
    return { status, user, ...(status === 'member' ? tag : {}) } as ChatMember;
  }

  /** The forum a topic method is about, with Telegram's errors. */
  private forumOf(p: Record<string, any>): SimChat {
    const chat = this.target(p.chat_id);
    if (!chat.forum) throw badRequest('the chat is not a forum');
    const status = chat.members.get(this.botInfo.id)?.status;
    if (status !== 'administrator' && status !== 'creator') throw badRequest('not enough rights to manage topics');
    return chat;
  }

  private topicOf(p: Record<string, any>): SimTopic {
    const topic = this.forumOf(p).topics!.find((t) => t.id === p.message_thread_id);
    if (!topic) throw badRequest('TOPIC_ID_INVALID');
    return topic;
  }

  private setTopicClosed(p: Record<string, any>, closed: boolean) {
    const topic = this.topicOf(p);
    if (topic.closed === closed) throw badRequest('TOPIC_NOT_MODIFIED');
    topic.closed = closed;
    const service = closed ? { forum_topic_closed: {} } : { forum_topic_reopened: {} };
    this.push(this.forumOf(p), this.botUser(), { ...service, message_thread_id: topic.id, is_topic_message: true } as Partial<Message>, true);
    return true;
  }

  private setGeneral(p: Record<string, any>, change: Partial<NonNullable<SimChat['general']>>) {
    const chat = this.forumOf(p);
    Object.assign(chat.general!, change);
    this.emit('change', { chatId: chat.id });
    return true;
  }

  /**
   * The group or channel an admin method is about, with Telegram's errors:
   * the chat type must fit, and the bot must be an admin with `right`.
   */
  private manage(p: Record<string, any>, right: string | undefined, action: string, types: Chat['type'][] = ['group', 'supergroup', 'channel']): SimChat {
    const chat = this.target(p.chat_id, true);
    if (!types.includes(chat.type)) {
      const key = types.join(',');
      throw badRequest(
        key === 'supergroup'
          ? 'method is available only for supergroups'
          : key === 'channel'
            ? 'method is available only for channels'
            : key === 'supergroup,channel'
              ? 'method is available for supergroup and channel chats only'
              : key === 'group,supergroup'
                ? 'method is available only for groups and supergroups'
                : "method isn't available for private chats",
      );
    }
    const bot = chat.members.get(this.botInfo.id);
    const admin = bot?.status === 'creator' || (bot?.status === 'administrator' && (right === undefined || bot.rights[right] !== false));
    if (!admin) throw badRequest(`not enough rights to ${action}`);
    return chat;
  }

  /** The point a location method gives, checked like Telegram. */
  private location(p: Record<string, any>): Location {
    const { latitude, longitude } = p;
    if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) throw badRequest('wrong latitude');
    if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) throw badRequest('wrong longitude');
    const location: Record<string, number> = { latitude, longitude };
    if (p.horizontal_accuracy !== undefined) {
      if (p.horizontal_accuracy < 0 || p.horizontal_accuracy > 1500) throw badRequest('wrong horizontal accuracy');
      location.horizontal_accuracy = p.horizontal_accuracy;
    }
    if (p.heading !== undefined) {
      if (!Number.isInteger(p.heading) || p.heading < 1 || p.heading > 360) throw badRequest('wrong heading');
      location.heading = p.heading;
    }
    if (p.proximity_alert_radius !== undefined) {
      if (!Number.isInteger(p.proximity_alert_radius) || p.proximity_alert_radius < 1 || p.proximity_alert_radius > 100000) throw badRequest('wrong proximity alert radius');
      location.proximity_alert_radius = p.proximity_alert_radius;
    }
    return location as unknown as Location;
  }

  /** A live location that can still be edited. */
  private liveLocation(p: Record<string, any>): SimMessage {
    const found = this.editable(p);
    if (!found.message.location || found.message.venue || found.liveUntil === undefined || found.liveUntil <= now()) throw badRequest("message can't be edited");
    return found;
  }

  private setBotText(kind: string, value: unknown, language: string | undefined, max: number) {
    if (language !== undefined && language !== '' && !/^[a-z]{2}$/.test(language)) throw badRequest('LANG_CODE_INVALID');
    const text = String(value ?? '');
    if (text.length > max) throw badRequest(`${kind.replace('_', ' ')} is too long`); // the simulator's wording
    const key = `${kind}|${language ?? ''}`;
    if (text) this.botTexts.set(key, text);
    else this.botTexts.delete(key);
    return true;
  }

  /** A bot text in a language, else the one for all languages. */
  private botText(kind: string, language: string | undefined): string | undefined {
    return this.botTexts.get(`${kind}|${language ?? ''}`) ?? this.botTexts.get(`${kind}|`);
  }

  /** The unique part of a t.me link. */
  private slug(): string {
    return `Sim${(this.nextLink++).toString(36).padStart(10, '0')}`;
  }

  /** A new invite link of the bot, checked (see `editLink`) before it's added. */
  private newLink(chat: SimChat, fields: Partial<ChatInviteLink>, p: Record<string, any> = {}): SimInviteLink {
    const link: SimInviteLink = {
      invite_link: `https://t.me/+${this.slug()}`,
      creator: this.botUser(),
      creates_join_request: false,
      is_primary: false,
      is_revoked: false,
      ...fields,
      joined: [],
    };
    this.editLink(link, p);
    (chat.inviteLinks ??= []).push(link);
    return link;
  }

  /** `exportChatInviteLink`: the bot's primary link is revoked and replaced. */
  private newPrimaryLink(chat: SimChat): SimInviteLink {
    for (const link of chat.inviteLinks ?? []) if (link.is_primary) link.is_revoked = true;
    const link = this.newLink(chat, { is_primary: true });
    this.emit('change', { chatId: chat.id });
    return link;
  }

  /** Name, expiry, member limit and approval of a link, with Telegram's checks. */
  private editLink(link: SimInviteLink, p: Record<string, any>) {
    if (p.name !== undefined && String(p.name).length > 32) throw badRequest('invite link name is too long');
    if (p.expire_date !== undefined && p.expire_date !== 0 && p.expire_date <= now()) throw badRequest('EXPIRE_DATE_INVALID');
    if (p.member_limit !== undefined && (!Number.isInteger(p.member_limit) || p.member_limit < 1 || p.member_limit > 99999)) throw badRequest('USAGE_LIMIT_INVALID');
    const approval = p.creates_join_request ?? link.creates_join_request;
    if (approval && (p.member_limit ?? link.member_limit) !== undefined) throw badRequest("member_limit can't be specified for links that require approval");
    if (p.name !== undefined) link.name = String(p.name) || undefined;
    if (p.expire_date !== undefined) link.expire_date = p.expire_date || undefined;
    if (p.member_limit !== undefined) link.member_limit = p.member_limit;
    if (p.creates_join_request !== undefined) link.creates_join_request = !!p.creates_join_request;
    for (const key of ['name', 'expire_date', 'member_limit'] as const) if (link[key] === undefined) delete link[key];
  }

  /** A link of this chat the bot made. */
  private botLink(chat: SimChat, inviteLink: unknown): SimInviteLink {
    const link = chat.inviteLinks?.find((l) => l.invite_link === inviteLink);
    if (!link) throw badRequest('INVITE_HASH_INVALID');
    return link;
  }

  /** A link as the Bot API returns it (`ChatInviteLink`). */
  private linkObject(chat: SimChat, link: SimInviteLink): ChatInviteLink {
    const { joined: _joined, ...rest } = link;
    if (!link.creates_join_request) return rest;
    const pending = [...(chat.joinRequests?.values() ?? [])].filter((r) => r.inviteLink === link.invite_link).length;
    return { ...rest, pending_join_request_count: pending };
  }

  private joinRequest(chat: SimChat, userId: number): SimJoinRequest {
    const request = chat.joinRequests?.get(userId);
    if (!request) throw badRequest('HIDE_REQUESTER_MISSING');
    return request;
  }

  /** A join request whose query is waiting for an answer (10 seconds). */
  private joinQuery(queryId: unknown): { chat: SimChat; request: SimJoinRequest } {
    for (const chat of this.chats.values()) {
      for (const request of chat.joinRequests?.values() ?? []) {
        if (request.queryId !== undefined && request.queryId === String(queryId) && now() - request.date <= 10) return { chat, request };
      }
    }
    throw badRequest('query is too old and response timeout expired or query ID is invalid');
  }

  /** An approved join request: the user joins (groups see it; the bot gets the message after its call returns). */
  private admit(chat: SimChat, request: SimJoinRequest) {
    chat.joinRequests?.delete(request.userId);
    const user = this.userOf(request.userId);
    chat.members.set(request.userId, { user, status: 'member', rights: {} });
    if (request.inviteLink) chat.inviteLinks?.find((l) => l.invite_link === request.inviteLink)?.joined.push(request.userId);
    if (chat.type === 'channel') {
      this.emit('change', { chatId: chat.id });
      return;
    }
    const message = this.push(chat, user, { new_chat_members: [user] }, false);
    this.followUp({ message: message.message } as Omit<Update, 'update_id'>);
  }

  /** The user asked to join a chat in the last 5 minutes: the bot may write to them (`user_chat_id`). */
  private askedToJoin(userId: number): boolean {
    for (const chat of this.chats.values()) {
      const request = chat.joinRequests?.get(userId);
      if (request && now() - request.date <= 300) return true;
    }
    return false;
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
    let thread: number | undefined = p.message_thread_id;
    if (replyTo !== undefined) {
      const replied = this.findMessage(chat.id, replyTo);
      if (replied) fields = { ...fields, reply_to_message: replied.message as never };
      else if (!p.reply_parameters?.allow_sending_without_reply) throw badRequest('message to be replied not found');
      if (thread === undefined && replied?.message.is_topic_message) thread = replied.message.message_thread_id;
    }
    // Outside forums a thread is a reply thread, which the simulator doesn't show apart.
    if (thread !== undefined && thread !== GENERAL_TOPIC && chat.forum) {
      if (!chat.topics!.some((t) => t.id === thread)) throw badRequest('message thread not found');
      fields = { ...fields, message_thread_id: thread, is_topic_message: true } as Partial<Message>;
    }
    if (chat.type === 'channel') {
      const status = chat.members.get(this.botInfo.id)?.status;
      if (status !== 'administrator' && status !== 'creator') throw badRequest('need administrator rights in the channel chat');
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
    // Channel posts are the channel's: `sender_chat`, no `from`.
    const author = chat.type === 'channel' ? { sender_chat: this.chatObject(chat) } : { from };
    const message = { message_id: id, date: now(), chat: this.chatObject(chat), ...author, ...clean } as Message;
    if (chat.forum && message.forum_topic_created) {
      // A topic's id is the id of the message that created it.
      Object.assign(message, { message_thread_id: id, is_topic_message: true });
      const created = message.forum_topic_created;
      chat.topics!.push({ id, name: created.name, iconColor: created.icon_color, iconCustomEmojiId: created.icon_custom_emoji_id, closed: false });
    }
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

const NUMERIC = /(^|_)(id|ids|offset|limit|timeout|latitude|longitude|date|duration|width|height|amount|period|count|radius|heading|position|length|price|accuracy)$/;

/** `live_period` for a live location without end. */
const LIVE_FOREVER = 0x7fffffff;
/** The rights `ChatAdministratorRights` has for groups and channels alike. */
const ADMIN_RIGHTS = [
  'is_anonymous',
  'can_manage_chat',
  'can_delete_messages',
  'can_manage_video_chats',
  'can_restrict_members',
  'can_promote_members',
  'can_change_info',
  'can_invite_users',
  'can_post_stories',
  'can_edit_stories',
  'can_delete_stories',
];
const PERMISSIONS = [
  'can_send_messages',
  'can_send_audios',
  'can_send_documents',
  'can_send_photos',
  'can_send_videos',
  'can_send_video_notes',
  'can_send_voice_notes',
  'can_send_polls',
  'can_send_other_messages',
  'can_add_web_page_previews',
  'can_react_to_messages',
  'can_change_info',
  'can_invite_users',
  'can_edit_tag',
  'can_pin_messages',
  'can_manage_topics',
];
const EMOJI = /\p{Extended_Pictographic}/u;
/** The address a user ships to when a test gives none. */
const DEFAULT_ADDRESS: ShippingAddress = { country_code: 'US', state: 'CA', city: 'San Francisco', street_line1: '1 Market St', street_line2: '', post_code: '94105' };

type InvoiceMessage = SimMessage & {
  invoicePayload?: string;
  invoiceNeeds?: { flexible?: boolean; shipping?: boolean; name?: boolean; phone?: boolean; email?: boolean };
};
type ShippingAnswer = { ok: boolean; options?: { id: string; title: string; prices: { label: string; amount: number }[] }[]; error?: string };

/** What a member is allowed to do in a group whose permissions were never set. */
function allPermissions(): ChatPermissions {
  return Object.fromEntries(PERMISSIONS.map((name) => [name, true])) as ChatPermissions;
}

function stripLive(location: Location): Location {
  const { live_period: _period, heading: _heading, proximity_alert_radius: _radius, ...rest } = location;
  return rest;
}

/** A user is in a chat (not left or banned). */
function isIn(chat: SimChat, userId: number): boolean {
  const status = chat.members.get(userId)?.status;
  return !!status && status !== 'left' && status !== 'kicked';
}

function reactedBy(reaction: SimReaction, p: Record<string, any>): boolean {
  return (p.user_id !== undefined && reaction.user === p.user_id) || (p.actor_chat_id !== undefined && reaction.actorChat === p.actor_chat_id);
}

function chatPhoto(fileId: string) {
  return { small_file_id: fileId, small_file_unique_id: fileId, big_file_id: fileId, big_file_unique_id: fileId };
}

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

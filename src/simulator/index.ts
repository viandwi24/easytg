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
  Update,
  User,
  UserFromGetMe,
} from 'grammy/types';
import { ParseError, parseFormatted } from './entities';

export { parseFormatted, parseHtml, parseMarkdownV2, ParseError } from './entities';

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
}

export interface SendOptions {
  /** The user sending; default: the first user. */
  user?: number;
  /** The chat; default: the user's private chat. */
  chat?: number;
  /** Reply to this message id. */
  replyTo?: number;
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
  /** Commands set with `setMyCommands` (default scope). */
  commands: { command: string; description: string }[] = [];
  latencyMs: number;

  private bot?: Bot<any>;
  private readonly listeners = new Map<keyof SimEvents, Set<Listener<any>>>();
  private readonly callLimit: number;
  private updateId = 1;
  private nextFile = 1;
  private nextQuery = 1;
  private nextGroup = 1;
  private readonly files = new Map<string, SimMedia>();
  private readonly messageIds = new Map<number, number>();
  private readonly callbackQueries = new Map<string, { answer?: SimCallbackAnswer; chatId?: number; userId: number }>();
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
  createGroup(options: { title: string; members?: number[]; admins?: number[]; id?: number; type?: 'group' | 'supergroup' }): SimChat {
    const id = options.id ?? -(1_000_000_000_000 + this.nextGroup++);
    const members = options.members ?? [this.user.id];
    const chat = this.newChat(id, options.type ?? 'supergroup', { title: options.title });
    members.forEach((userId, index) => {
      const status = index === 0 ? 'creator' : options.admins?.includes(userId) ? 'administrator' : 'member';
      chat.members.set(userId, { user: this.userOf(userId), status, rights: {} });
    });
    chat.members.set(this.botInfo.id, { user: this.botUser(), status: 'administrator', rights: {} });
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
  messages(chatId = this.user.id): SimMessage[] {
    return this.chats.get(chatId)?.messages ?? [];
  }

  /** The last message in a chat. */
  last(chatId = this.user.id): SimMessage | undefined {
    return this.messages(chatId).at(-1);
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

  /* ---------------------------- user actions ---------------------------- */

  /** A user sends a text message. Resolves when the bot has handled it (unless the bot polls with `bot.start()`). */
  async send(text: string, options: SendOptions = {}): Promise<SimMessage> {
    if (!text) throw new Error('Empty message');
    const formatted = parseFormatted(text, undefined, undefined);
    return this.userMessage({ text, entities: formatted.entities.length ? formatted.entities : undefined }, options);
  }

  /** A user sends a photo (any URL a browser can show) or a document. */
  async sendMedia(kind: SimMediaKind, source: { url?: string; name?: string; caption?: string }, options: SendOptions = {}) {
    const fileId = this.registerFile({ kind, url: source.url, name: source.name });
    const file = { file_id: fileId, file_unique_id: fileId, file_size: 1024 };
    const media =
      kind === 'photo'
        ? { photo: [{ ...file, width: 800, height: 600 }] }
        : { [kind]: { ...file, file_name: source.name, ...(kind === 'video' || kind === 'animation' ? { width: 640, height: 360, duration: 5 } : {}) } };
    return this.userMessage({ ...media, caption: source.caption }, options, { kind, url: source.url, name: source.name });
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
    button: string | [number, number] | InlineKeyboardButton,
    options: { user?: number; chat?: number; inlineMessageId?: string } = {},
  ): Promise<SimCallbackAnswer> {
    const userId = options.user ?? this.user.id;
    const found = options.inlineMessageId ? this.findInline(options.inlineMessageId) : this.findMessage(options.chat ?? userId, messageId);
    if (!found) throw new Error(`No message ${messageId} in chat ${options.chat ?? userId}`);
    const rows = (found.message.reply_markup as InlineKeyboardMarkup | undefined)?.inline_keyboard ?? [];
    const target =
      typeof button === 'object' && !Array.isArray(button)
        ? button
        : Array.isArray(button)
          ? rows[button[0]]?.[button[1]]
          : rows.flat().find((b) => ('callback_data' in b && b.callback_data === button) || b.text === button);
    if (!target) throw new Error(`No button ${JSON.stringify(button)} on message ${messageId}`);
    const chatId = found.message.chat.id;

    if ('url' in target && target.url) return this.open(target.url, 'url', chatId, userId);
    if ('web_app' in target && target.web_app) return this.open(target.web_app.url, 'webApp', chatId, userId);
    if ('login_url' in target && target.login_url) return this.open(target.login_url.url, 'login', chatId, userId);
    if ('pay' in target && target.pay) return (await this.pay(found.message.message_id, { user: userId, chat: chatId }), {});
    if ('copy_text' in target && target.copy_text) return { text: 'Copied to clipboard' };
    if (!('callback_data' in target) || target.callback_data === undefined) return {};

    const id = String(this.nextQuery++);
    const query = { chatId, userId, answer: undefined as SimCallbackAnswer | undefined };
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
    if (options.replyTo !== undefined) {
      const replied = this.findMessage(chat.id, options.replyTo);
      if (replied) fields = { ...fields, reply_to_message: replied.message as never };
    }
    if (chat.forceReply) chat.forceReply = null;
    const message = this.push(chat, this.userOf(userId), fields, false, media);
    await this.deliver({ message: message.message } as Omit<Update, 'update_id'>);
    return message;
  }

  private async deliver(update: Omit<Update, 'update_id'>) {
    const full = { update_id: this.updateId++, ...update } as Update;
    const bot = this.bot;
    if (!bot) throw new Error('Connect a bot first: sim.connect(bot)');
    if (bot.isRunning()) {
      // bot.start(): hand it out through getUpdates; grammY confirms it once handled.
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
      if (found.message.text === undefined) throw badRequest('there is no text in the message to edit');
      const formatted = this.format(String(p.text ?? ''), p.parse_mode, p.entities, MESSAGE_LIMIT, 'message is too long');
      if (!formatted.text.trim()) throw badRequest('message text is empty');
      const entities = formatted.entities.length ? formatted.entities : undefined;
      return this.applyEdit(found, p, { text: formatted.text, entities }, () => found.message.text === formatted.text && same(found.message.entities, entities));
    },

    editMessageCaption: (p: Record<string, any>) => {
      const found = this.editable(p);
      if (!found.media) throw badRequest('there is no caption in the message to edit');
      const caption = this.caption(p);
      return this.applyEdit(found, p, caption, () => found.message.caption === caption.caption && same(found.message.caption_entities, caption.caption_entities));
    },

    editMessageMedia: (p: Record<string, any>) => {
      const found = this.editable(p);
      if (!found.media) throw badRequest('there is no media in the message to edit');
      const item = p.media as Record<string, any>;
      const kind = item.type as SimMediaKind;
      const media = this.mediaFrom(kind, item.media, item.media?.filename);
      const cleared = Object.fromEntries(MEDIA_KINDS.map((k) => [k, undefined]));
      found.media = media;
      return this.applyEdit(found, p, { ...cleared, ...this.mediaFields(kind, media), ...this.caption(item) }, () => false);
    },

    editMessageReplyMarkup: (p: Record<string, any>) => {
      const found = this.editable(p);
      return this.applyEdit(found, p, {}, () => true);
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
      if (!p.scope || p.scope.type === 'default') this.commands = p.commands;
      this.emit('change', {});
      return true;
    },
    getMyCommands: () => this.commands,
    deleteMyCommands: () => {
      this.commands = [];
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
      return { file_id: p.file_id, file_unique_id: p.file_id, file_size: 1024, file_path: file.url ?? `${file.kind}/${p.file_id}` };
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
      const kinds = ['callback_data', 'url', 'web_app', 'login_url', 'switch_inline_query', 'switch_inline_query_current_chat', 'switch_inline_query_chosen_chat', 'copy_text', 'callback_game', 'pay'];
      if (!kinds.some((k) => k in button)) throw badRequest('text buttons are unallowed in the inline keyboard');
    }
  }

  private registerFile(media: SimMedia): string {
    const id = `sim-${media.kind}-${this.nextFile++}`;
    this.files.set(id, media);
    return id;
  }

  /** What the UI can show for a media source: a URL, an InputFile (Blob, bytes, URL) or a file id. */
  private mediaFrom(kind: SimMediaKind, source: unknown, filename?: string): SimMedia {
    if (typeof source === 'string') {
      const known = this.files.get(source);
      if (known) return { ...known, kind };
      if (/^(https?:|data:|blob:)/.test(source)) return { kind, url: source, name: filename ?? source.split('/').pop()?.split('?')[0] };
      return { kind, name: filename };
    }
    const data = (source as { fileData?: unknown } | undefined)?.fileData;
    const name = filename ?? (source as { filename?: string } | undefined)?.filename;
    if (data instanceof URL) return { kind, url: data.href, name };
    if (typeof data === 'string' && /^(https?:|data:|blob:)/.test(data)) return { kind, url: data, name };
    const createUrl = (globalThis as { URL?: { createObjectURL?: (blob: Blob) => string } }).URL?.createObjectURL;
    if (createUrl && typeof Blob !== 'undefined') {
      if (data instanceof Blob) return { kind, url: createUrl(data), name };
      if (data instanceof Uint8Array) return { kind, url: createUrl(new Blob([data as never])), name };
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

  private botMessage(chat: SimChat, p: Record<string, any>, fields: Partial<Message>, media?: SimMedia): SimMessage {
    const markup = p.reply_markup as Record<string, any> | undefined;
    this.checkMarkup(markup);
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
    const inline = markup?.inline_keyboard ? { reply_markup: markup as InlineKeyboardMarkup } : {};
    return this.push(chat, this.botUser(), { ...fields, ...inline, ...(p.protect_content ? { has_protected_content: true } : {}) } as Partial<Message>, true, media);
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

function formatAmount(amount: number, currency: string) {
  if (currency === 'XTR') return `⭐️ ${amount}`;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${amount / 100} ${currency}`;
  }
}

/**
 * Test helpers: a grammY bot whose API calls are recorded and answered locally,
 * so easytg pages and dialogues can be tested without a token or network.
 *
 *   import { createTestBot } from 'easytg/testing';
 */
import { Bot, GrammyError, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { StorageAdapter } from './storage';

export interface ApiCall {
  method: string;
  payload: Record<string, any>;
}

/** Return a result, or an Error (e.g. `telegramError(...)`) to make the call fail. */
export type Responder = (payload: Record<string, any>) => unknown;

/**
 * - `message(text)` / `press(callbackData)` / `update(raw)` feed updates through your middleware
 * - `calls`, `find(method)`, `methods()` inspect what the bot sent
 * - `responders[method]` customise API responses
 */
export interface TestBotOptions {
  /** Override the bot's identity, e.g. `{ id: 2, username: 'second_bot' }` to test several bots. */
  botInfo?: Partial<UserFromGetMe>;
  /** First message id the fake API hands out. Default 1000. */
  firstMessageId?: number;
}

export function createTestBot<C extends Context = Context>(options: TestBotOptions = {}) {
  const bot = new Bot<C>(`${options.botInfo?.id ?? 1}:TEST`, {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      ...options.botInfo,
    } as UserFromGetMe,
  });

  const calls: ApiCall[] = [];
  const sent: { message_id: number }[] = [];
  const responders: Record<string, Responder> = {};
  let nextMessageId = options.firstMessageId ?? 1000;

  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, any>;
    calls.push({ method, payload: p });
    const responder = responders[method];
    if (responder) {
      const result = responder(p);
      if (result instanceof Error) throw result;
      return { ok: true, result } as any;
    }
    const message = (text?: string) => {
      const result = {
        message_id: nextMessageId++,
        date: 1,
        chat: { id: p.chat_id, type: p.chat_id < 0 ? 'group' : 'private' },
        text,
      };
      sent.push(result);
      return result;
    };
    if (method.startsWith('send')) {
      // Like Telegram, an album comes back as one message per item.
      const result = method === 'sendMediaGroup' ? (p.media as unknown[]).map(() => message()) : message(p.text);
      return { ok: true, result } as any;
    }
    // Copies return only { message_id }; forwards return the new message. Batch variants return one per id.
    if (method === 'copyMessage' || method === 'forwardMessage') {
      const { message_id } = message(p.caption);
      const result = method === 'copyMessage' ? { message_id } : sent.at(-1);
      return { ok: true, result } as any;
    }
    if (method === 'copyMessages' || method === 'forwardMessages') {
      return { ok: true, result: (p.message_ids as number[]).map(() => ({ message_id: message().message_id })) } as any;
    }
    return { ok: true, result: true } as any;
  });

  let updateId = 1;
  const user = (id: number, language?: string) => ({ id, is_bot: false, first_name: `U${id}`, language_code: language });
  const chat = (id: number, type: 'private' | 'group') =>
    type === 'private' ? { id, type, first_name: 'U' } : { id, type, title: 'G' };

  const helpers = {
    bot,
    calls,
    sent,
    responders,
    reset() {
      calls.length = 0;
    },
    methods() {
      return calls.map((c) => c.method);
    },
    find(method: string) {
      return calls.filter((c) => c.method === method);
    },
    async message(
      text: string,
      opts: { userId?: number; chatId?: number; chatType?: 'private' | 'group'; language?: string; extra?: object } = {},
    ) {
      const userId = opts.userId ?? 7;
      const chatType = opts.chatType ?? 'private';
      const chatId = opts.chatId ?? (chatType === 'private' ? userId : -100);
      const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : undefined;
      const update = {
        update_id: updateId++,
        message: { message_id: nextMessageId++, date: 1, chat: chat(chatId, chatType), from: user(userId, opts.language), text, entities, ...opts.extra },
      } as unknown as Update;
      await bot.handleUpdate(update);
    },
    /** Feed any raw update (inline queries, payments, member updates, …); `update_id` is filled in. */
    async update(update: Omit<Update, 'update_id'>) {
      await bot.handleUpdate({ update_id: updateId++, ...update } as Update);
    },
    async press(
      data: string,
      opts: {
        userId?: number;
        chatId?: number;
        chatType?: 'private' | 'group';
        language?: string;
        messageId?: number;
        message?: object;
      } = {},
    ) {
      const userId = opts.userId ?? 7;
      const chatType = opts.chatType ?? 'private';
      const chatId = opts.chatId ?? (chatType === 'private' ? userId : -100);
      const update = {
        update_id: updateId++,
        callback_query: {
          id: `q${updateId}`,
          from: user(userId, opts.language),
          chat_instance: 'x',
          data,
          message: {
            message_id: opts.messageId ?? 500,
            date: 1,
            chat: chat(chatId, chatType),
            from: { id: 1, is_bot: true, first_name: 'Test' },
            text: 'old',
            ...opts.message,
          },
        },
      } as unknown as Update;
      await bot.handleUpdate(update);
    },
  };
  return helpers;
}

/** A Telegram API error to return from a responder, e.g. `telegramError('Forbidden: bot was blocked by the user', { code: 403 })`. */
export function telegramError(description: string, options: { code?: number; retryAfter?: number } = {}) {
  const parameters = options.retryAfter !== undefined ? { retry_after: options.retryAfter } : undefined;
  return new GrammyError(description, { ok: false, error_code: options.code ?? 400, description, parameters }, 'x', {});
}

/**
 * Check that your own StorageAdapter (Redis, SQL, ...) behaves the way easytg
 * expects. Throws with a description of the first mismatch.
 */
export async function verifyStorageAdapter(storage: StorageAdapter, keyPrefix = `easytg-verify:${Date.now()}:`) {
  const fail = (what: string) => {
    throw new Error(`StorageAdapter check failed: ${what}`);
  };
  const k = (name: string) => keyPrefix + name;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  if ((await storage.get(k('missing'))) != null) fail('get() of a missing key must return null or undefined');

  const value = { n: 1, s: 'x', list: [1, 2], nested: { ok: true } };
  await storage.set(k('obj'), value);
  if (!same(await storage.get(k('obj')), value)) fail('set() then get() must return an equal object (not a string)');

  await storage.set(k('num'), 42);
  if ((await storage.get(k('num'))) !== 42) fail('numbers must round-trip as numbers');

  await storage.set(k('obj'), { n: 2 });
  if (!same(await storage.get(k('obj')), { n: 2 })) fail('set() must overwrite an existing key');

  await storage.delete(k('obj'));
  if ((await storage.get(k('obj'))) != null) fail('delete() must remove the key');
  await storage.delete(k('never-existed')); // must not throw

  await storage.set(k('ttl'), 'soon', 1);
  if ((await storage.get(k('ttl'))) !== 'soon') fail('a key with a TTL must be readable before it expires');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  if ((await storage.get(k('ttl'))) != null) fail('a key must expire after ttlSeconds');

  await storage.delete(k('num'));
}

/**
 * Test helpers: a grammY bot whose API calls are recorded and answered locally,
 * so easytg pages and dialogues can be tested without a token or network.
 *
 *   import { createTestBot } from 'easytg/testing';
 */
import { Bot, GrammyError, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { StorageAdapter, StoredTask, TaskStore } from './storage';

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
    if (method.startsWith('send') && method !== 'sendChatAction') {
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
export async function verifyStorageAdapter(storage: StorageAdapter, options: { keyPrefix?: string; ttlMs?: number } = {}) {
  const { keyPrefix = `easytg-verify:${Date.now()}:`, ttlMs: ttl = 1000 } = options;
  const expire = () => new Promise((resolve) => setTimeout(resolve, ttl + 100));
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

  await storage.set(k('ttl'), 'soon', ttl);
  if ((await storage.get(k('ttl'))) !== 'soon') fail('a key with a TTL must be readable before it expires');
  await expire();
  if ((await storage.get(k('ttl'))) != null) fail('a key must expire after ttlMs');

  await storage.delete(k('num'));

  // Fractional TTLs (rate-limit windows are short).
  await storage.set(k('half'), 1, ttl / 2);
  if ((await storage.get(k('half'))) !== 1) fail('a key with a fractional TTL must be readable before it expires');
  await new Promise((resolve) => setTimeout(resolve, ttl / 2 + 100));
  if ((await storage.get(k('half'))) != null) fail('a TTL below a second must be honoured (not rounded up to whole seconds)');

  if (storage.increment) {
    const created = Date.now();
    if ((await storage.increment(k('count'), 1, ttl)) !== 1) fail('increment() of a missing key must start at 0');
    await new Promise((resolve) => setTimeout(resolve, ttl * 0.6));
    if ((await storage.increment(k('count'), 2, ttl)) !== 3) fail('increment() must add to the current value');
    const counts = await Promise.all(Array.from({ length: 20 }, () => storage.increment!(k('race'), 1)));
    if (new Set(counts).size !== 20 || Math.max(...counts) !== 20) fail('concurrent increment() calls must not lose updates');
    if ((await storage.get(k('count'))) !== 3) fail('get() of a counter must return the number');
    // The TTL counts from the key's creation: later increments must not extend it (a fixed window).
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, created + ttl + 100 - Date.now())));
    if ((await storage.increment(k('count'), 1)) !== 1) fail('increment() must not extend the TTL set when the key was created');
    await storage.delete(k('count'));
    await storage.delete(k('race'));
  }

  if (storage.setIfAbsent) {
    if (!(await storage.setIfAbsent(k('lock'), 'a', ttl))) fail('setIfAbsent() of a missing key must set it and return true');
    if (await storage.setIfAbsent(k('lock'), 'b', ttl)) fail('setIfAbsent() of an existing key must return false');
    if ((await storage.get(k('lock'))) !== 'a') fail('setIfAbsent() must not overwrite');
    const wins = await Promise.all(Array.from({ length: 10 }, (_, i) => storage.setIfAbsent!(k('race-lock'), i, ttl)));
    if (wins.filter(Boolean).length !== 1) fail('exactly one of concurrent setIfAbsent() calls must win');
    await expire();
    if (!(await storage.setIfAbsent(k('lock'), 'c', ttl))) fail('setIfAbsent() of an expired key must set it');
    if (!(await storage.setIfAbsent(k('race-lock'), 'x', ttl))) fail('setIfAbsent() must honour its TTL');
    await storage.delete(k('lock'));
    await storage.delete(k('race-lock'));
  }
}

/**
 * Check a `TaskStore` (scheduled tasks). Use an empty store: it claims every
 * due task. Throws with a description of the first mismatch.
 */
export async function verifyTaskStore(store: TaskStore) {
  const fail = (what: string) => {
    throw new Error(`TaskStore check failed: ${what}`);
  };
  const now = Date.now();
  const task = (id: string, runAt: number, extra: Partial<StoredTask> = {}): StoredTask => ({
    id,
    name: 'check',
    payload: { id, list: [1, 2], nested: { ok: true } },
    runAt,
    dueAt: runAt,
    attempts: 0,
    ...extra,
  });

  await store.saveTask(task('later', now + 60_000));
  await store.saveTask(task('b', now - 1000, { everyMs: 5000, bot: 42 }));
  await store.saveTask(task('a', now - 2000));
  const claimed = await store.claimTasks(now, 10, 30_000);
  if (claimed.map((t) => t.id).join() !== 'a,b') fail('claimTasks() must return due tasks only, earliest first');
  const b = claimed[1]!;
  if (JSON.stringify(b.payload) !== JSON.stringify(task('b', 0).payload)) fail('payloads must round-trip');
  if (b.attempts !== 1 || b.runAt !== now + 30_000 || b.dueAt !== now - 1000 || b.everyMs !== 5000 || b.bot !== 42) {
    fail('claimed tasks must come back with attempts + 1, runAt = now + leaseMs, and dueAt, everyMs and bot unchanged');
  }
  if ((await store.claimTasks(now, 10, 30_000)).length !== 0) fail('claimed tasks must not be claimed again before the lease ends');
  await store.finishTask(b);
  const again = await store.claimTasks(now + 30_000, 10, 30_000);
  if (again.length !== 1 || again[0]!.id !== 'a' || again[0]!.attempts !== 2) {
    fail('finishTask() must delete the task; unfinished tasks must be claimed again after the lease');
  }
  await store.finishTask(claimed[0]!); // a was claimed again since: must be ignored
  const left = await store.claimTasks(now + 120_000, 10, 1000);
  if (left.map((t) => t.id).sort().join() !== 'a,later') fail('finishTask() of a task claimed again since must be ignored');

  const a = left.find((t) => t.id === 'a')!;
  await store.finishTask(a, { ...a, runAt: now + 200_000, attempts: a.attempts });
  const rescheduled = await store.claimTasks(now + 200_000, 10, 1000);
  if (!rescheduled.some((t) => t.id === 'a')) fail('finishTask(task, next) must save the next run');

  await store.saveTask(task('gone', now));
  if (!(await store.deleteTask('gone'))) fail('deleteTask() must return true for an existing task');
  if (await store.deleteTask('gone')) fail('deleteTask() must return false for a missing task');
  for (const id of ['a', 'b', 'later']) await store.deleteTask(id);

  // Several processes claiming at once: every task exactly once, `limit` respected.
  for (let i = 0; i < 10; i++) await store.saveTask(task(`race-${i}`, now - i));
  const claims = await Promise.all([store.claimTasks(now, 6, 60_000), store.claimTasks(now, 6, 60_000), store.claimTasks(now, 6, 60_000)]);
  if (claims.some((c) => c.length > 6)) fail('claimTasks() must return at most `limit` tasks');
  const raced = claims.flat().map((t) => t.id);
  if (raced.length !== 10 || new Set(raced).size !== 10) fail('concurrent claimTasks() calls must claim every due task exactly once');
  for (const id of raced) await store.deleteTask(id);
}

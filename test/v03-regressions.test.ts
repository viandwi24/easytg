import { describe, expect, test } from 'bun:test';
import { Bot } from 'grammy';
import { EasyTG, MemoryStorage, QueueFullError, page, type EasyTGOptions, type StorageAdapter } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options });
  t.bot.use(app);
  return { ...t, app };
}

describe('0.3 regressions', () => {
  test('the scheduler initialises bots before picking the one a task belongs to', async () => {
    const { app, message, bot: testBot } = setup();
    testBot.command('bye', async (ctx) => app.deleteLater(ctx, 1, { delayMs: 0 })); // task bound to bot id 1
    await message('/bye');

    const calls: string[] = [];
    const bot = new Bot('1:TEST'); // not initialised
    bot.api.config.use(async (_prev, method) => {
      calls.push(method);
      const result = method === 'getMe' ? { id: 1, is_bot: true, first_name: 'T', username: 'test_bot' } : true;
      return { ok: true, result } as never;
    });
    expect(await app.runDueTasks(bot)).toBe(1);
    expect(calls).toEqual(['getMe', 'deleteMessages']);
  });

  test("a task for a bot the scheduler doesn't run is left for another process", async () => {
    const storage = new MemoryStorage();
    const { app, bot, find } = setup({ storage });
    await app.deleteLater({ chatId: 5, botId: 999 }, 1, { delayMs: 0 });
    expect(await app.runDueTasks(bot)).toBe(1); // claimed, then put back
    expect(find('deleteMessages').length).toBe(0);
    const [left] = await storage.claimTasks(Date.now() + 10 * 60_000, 10, 1000);
    expect(left).toMatchObject({ bot: 999, attempts: 1 });
  });

  test('a storage failure while taking a shared queue slot frees the local slot', async () => {
    const storage = new MemoryStorage();
    let failures = 1;
    const flaky: StorageAdapter = {
      get: (k) => storage.get(k),
      set: (k, v, t) => storage.set(k, v, t),
      delete: (k) => storage.delete(k),
      increment: (k, by, t) => storage.increment(k, by, t),
      setIfAbsent: (k, v, t) => (failures-- > 0 ? Promise.reject(new Error('redis down')) : storage.setIfAbsent(k, v, t)),
    };
    const { app } = setup({ storage: flaky, cluster: true, queues: { q: { concurrency: 1, timeoutMs: 200 } } });
    await expect(app.queue('q', () => 1)).rejects.toThrow('redis down');
    expect(await app.queue('q', () => 'ok')).toBe('ok');
  });

  test('perUser is enforced across processes', async () => {
    const storage = new MemoryStorage();
    const options = { storage, cluster: true, queues: { q: { concurrency: 5, perUser: 1 } } } as const;
    const a = setup(options);
    const b = setup(options);
    let error: unknown;
    a.bot.on('message', (ctx) => a.app.queue('q', () => Bun.sleep(40), { ctx }));
    b.bot.on('message', (ctx) => b.app.queue('q', () => Bun.sleep(40), { ctx }).catch((e) => void (error = e)));
    await Promise.all([a.message('1'), Bun.sleep(5).then(() => b.message('2', { chatId: 99 }))]);
    expect(error).toBeInstanceOf(QueueFullError);
    // Released afterwards: the next job is accepted.
    await b.message('3', { chatId: 98 });
  });

  test('presses while busy still count towards the rate limit', async () => {
    const { app, press } = setup({ antiSpam: { limit: 3, warn: false } });
    app.register(
      page('slow').render(async () => {
        await Bun.sleep(40);
        return { text: 'done' };
      }),
    );
    let spam = 0;
    app.on('spam', () => void spam++);
    const first = press('p|slow');
    for (let i = 0; i < 5; i++) await press('p|slow', { messageId: 600 + i });
    await first;
    expect(spam).toBe(1);
    expect(await app.isLimited(7)).toBe(true);
  });

  test("a limited user's messages don't wait for the lock", async () => {
    const { app, bot, message } = setup({ sequential: { timeoutMs: 5_000 } });
    bot.on('message', async (ctx) => {
      if (ctx.message.text === 'slow') await Bun.sleep(300);
    });
    const slow = message('slow');
    await Bun.sleep(5);
    await app.limitUser(7, 60_000);
    const started = Date.now();
    await message('dropped');
    expect(Date.now() - started).toBeLessThan(100);
    await slow;
  });

  test('a command ends a page’s text input', async () => {
    const { app, bot, message, find } = setup();
    const search = page<{ q?: string }>('search')
      .render(({ params }) => ({ text: `q=${params.q ?? ''}`, parseMode: 'plain' }))
      .onText(({ text, nav }) => nav.redirect(search, { q: text }));
    app.register(search);
    const seen: string[] = [];
    bot.command('search', (ctx) => app.open(ctx, search));
    bot.command('help', () => void seen.push('/help'));
    bot.on('message:text', (ctx) => void seen.push(ctx.message.text));
    await message('/search');
    await message('/help');
    await message('hello');
    expect(seen).toEqual(['/help', 'hello']);
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['q=']);
  });

  test('a message group may contain a key named "other"', () => {
    const { app } = setup({ i18n: { messages: { en: { settings: { other: 'Other', language: 'Language' } } } } });
    expect(app.t('en')('settings.language')).toBe('Language');
    expect(app.t('en')('settings.other')).toBe('Other');
  });
});

// Staying within Telegram's limits: app.throttle and autoRetry.
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, type EasyTGOptions, autoRetry } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

describe('throttle', () => {
  const run = async (options: Parameters<EasyTG['throttle']>[0], chatId: number, count: number, storage?: MemoryStorage) => {
    const { app, bot } = setup(storage ? { storage, cluster: true } : {});
    bot.api.config.use(app.throttle(options));
    const started = Date.now();
    await Promise.all(Array.from({ length: count }, (_, i) => bot.api.sendMessage(chatId, `m${i}`)));
    return Date.now() - started;
  };

  test('groups are limited per window; private chats and custom rules are not by default', async () => {
    expect(await run({ groupChat: { limit: 2, perMs: 150 } }, -100, 5)).toBeGreaterThanOrEqual(140); // 3 windows
    expect(await run({ groupChat: { limit: 2, perMs: 150 } }, 7, 5)).toBeLessThan(100);
    expect(await run({ groupChat: { limit: 2, perMs: 150 }, chat: (id) => (id === -100 ? false : undefined) }, -100, 5)).toBeLessThan(100);
  });

  test('the global limit and chat actions', async () => {
    expect(await run({ global: { limit: 3, perMs: 150 } }, 7, 9)).toBeGreaterThanOrEqual(140); // 3 windows
    const { app, bot } = setup();
    bot.api.config.use(app.throttle({ global: { limit: 1, perMs: 1000 } }));
    const started = Date.now();
    await Promise.all([bot.api.sendChatAction(7, 'typing'), bot.api.sendChatAction(7, 'typing'), bot.api.getMe()]);
    expect(Date.now() - started).toBeLessThan(100); // not messages: never waited for
  });

  test('with cluster, processes count together', async () => {
    const storage = new MemoryStorage();
    const rule = { groupChat: { limit: 2, perMs: 200 } };
    const [a, b] = await Promise.all([run(rule, -100, 3, storage), run(rule, -100, 3, storage)]); // 6 sends: 3 windows together
    expect(Math.max(a, b)).toBeGreaterThanOrEqual(190);
  });
});

describe('autoRetry', () => {
  test('waits out 429 answers; other errors are returned', async () => {
    const retry = autoRetry({ maxRetries: 2 });
    let calls = 0;
    const tooMany = { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0.01 } };
    const prev = (async () => (++calls < 3 ? tooMany : { ok: true, result: true })) as never;
    expect(await retry(prev, 'sendMessage', {} as never)).toEqual({ ok: true, result: true } as never);
    expect(calls).toBe(3);

    calls = 0;
    const bad = { ok: false, error_code: 400, description: 'Bad Request' };
    expect(await retry((async () => (calls++, bad)) as never, 'sendMessage', {} as never)).toEqual(bad as never);
    expect(calls).toBe(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { GrammyError } from 'grammy';
import { EasyTG, autoRetry, retryAfterMs } from '../src';
import { TelegramSimulator } from '../src/simulator';

const limits = { global: { limit: 30, perMs: 1000 }, groupChat: { limit: 3, perMs: 400 }, privateChat: false as const };

describe('simulated rate limits', () => {
  test('too many messages to a group get 429 with retry_after, like Telegram', async () => {
    const sim = new TelegramSimulator({ rateLimits: limits });
    const bot = sim.createBot();
    const group = sim.createGroup({ title: 'G' });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => bot.api.sendMessage(group.id, `#${i}`).then(() => 'ok', (e: GrammyError) => e)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(3);
    const error = results.find((r) => r !== 'ok') as GrammyError;
    expect(error.error_code).toBe(429);
    expect(error.description).toBe('Too Many Requests: retry after 1');
    expect(retryAfterMs(error)).toBe(1000);
    // Private chats have no limit by default; an album counts one per item.
    await sim.send('hi');
    for (let i = 0; i < 5; i++) await bot.api.sendMessage(sim.user.id, 'x');
  });

  test('app.throttle keeps a burst under the limits', async () => {
    const sim = new TelegramSimulator({ rateLimits: limits });
    const bot = sim.createBot();
    const app = new EasyTG({ logger: false });
    bot.api.config.use(app.throttle({ groupChat: { limit: 3, perMs: 400 } }));
    const group = sim.createGroup({ title: 'G' });
    const started = Date.now();
    await Promise.all(Array.from({ length: 7 }, (_, i) => bot.api.sendMessage(group.id, `#${i}`)));
    expect(sim.messages(group.id)).toHaveLength(7);
    expect(sim.calls.filter((c) => c.error)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400); // spread over three windows (the first may be half over)
  });

  test('autoRetry waits out a 429', async () => {
    const sim = new TelegramSimulator({ rateLimits: { groupChat: { limit: 1, perMs: 300 } } });
    const bot = sim.createBot();
    bot.api.config.use(autoRetry());
    const group = sim.createGroup({ title: 'G' });
    await bot.api.sendMessage(group.id, 'a');
    await bot.api.sendMessage(group.id, 'b'); // 429, retried after 1 s
    expect(sim.messages(group.id).map((m) => m.message.text)).toEqual(['a', 'b']);
    expect(sim.calls.filter((c) => c.error).map((c) => c.error)).toEqual(['Too Many Requests: retry after 1']);
  });
});

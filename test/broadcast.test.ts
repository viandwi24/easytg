// Broadcasts: pacing, and broadcastLater batches.
import { describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions, type EasyTGEvents } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

describe('broadcasts', () => {
  test('several sends in flight reach the rate a slow API allows', async () => {
    const { app, bot, responders } = setup();
    app.register(page('news').render(() => ({ text: 'news' })));
    responders.sendMessage = (p) => Bun.sleep(40).then(() => ({ message_id: 1, date: 1, chat: { id: p.chat_id, type: 'private' } }));
    const started = Date.now();
    const result = await app.broadcast(bot, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], page('news'), { perSecond: 1000, concurrency: 5 });
    expect(result.sent).toBe(10);
    expect(Date.now() - started).toBeLessThan(300); // one at a time: ≥ 400 ms
  });

  test('broadcastLater sends in scheduled batches and reports each', async () => {
    const { app, bot, find } = setup();
    app.register(page('news').render(() => ({ text: 'news' })));
    const batches: EasyTGEvents['broadcastBatch'][] = [];
    app.on('broadcastBatch', (e) => void batches.push(e));
    const { batches: count } = await app.broadcastLater([1, 2, 3, 4, 5], page('news'), { batchSize: 2, perSecond: 1000, botId: 1 });
    expect(count).toBe(3);
    try {
      setSystemTime(new Date(Date.now() + 1000));
      await app.runDueTasks(bot);
    } finally {
      setSystemTime();
    }
    expect(find('sendMessage').map((c) => c.payload.chat_id).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(batches.map((b) => [b.batch, b.result.sent]).sort()).toEqual([
      [0, 2],
      [1, 2],
      [2, 1],
    ]);
  });
});

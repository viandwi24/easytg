// Queues, limits and nested flows: what runs while what.
import { describe, expect, test, setSystemTime } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const buttons = () => t.calls.filter((c) => c.payload.reply_markup?.inline_keyboard).at(-1)!.payload.reply_markup.inline_keyboard.flat();
  const button = (label: string) => buttons().find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, buttons, button };
}

describe('queues and limits', () => {
  test('a queue slot held by the update is not waited for again', async () => {
    const { app, bot, message } = setup({ queues: { ai: { concurrency: 1 } } });
    let done = false;
    bot.on('message', async (ctx) => {
      await app.enterQueue(ctx, 'ai');
      await app.enterQueue(ctx, 'ai');
      await app.queue('ai', () => app.queue('ai', () => undefined, { ctx }), { ctx });
      done = true;
    });
    await message('hi');
    expect(done).toBe(true);
    expect(await app.queue('ai', () => 'free')).toBe('free');
  });

  test('limitUser drops every update of the user, except payments', async () => {
    const { app, bot, message } = setup();
    let handled = 0;
    bot.on('message', () => void handled++);
    await app.limitUser(7, 60_000);
    await message('hi group', { chatType: 'group' });
    await message('hi', { extra: { edit_date: 2 } });
    expect(handled).toBe(0);
  });

  test('concurrent updates over the limit give one spam event', async () => {
    const storage = new MemoryStorage();
    const a = setup({ storage, cluster: true, antiSpam: { limit: 2, warn: false } });
    const b = setup({ storage, cluster: true, antiSpam: { limit: 2, warn: false } });
    let events = 0;
    for (const { app } of [a, b]) app.on('spam', () => void events++);
    await a.message('1');
    await b.message('2', { chatId: 50 });
    await Promise.all([a.message('3', { chatId: 51 }), b.message('4', { chatId: 52 }), a.message('5', { chatId: 53 })]);
    expect(events).toBe(1);
  });
});

describe('nested flows', () => {
  test('sendTo from a spam listener does not wait for the lock its own update holds', async () => {
    const { app, bot, message } = setup({ antiSpam: { limit: 1, warn: false }, sequential: { timeoutMs: 2000 } });
    app.register(page('muted').render(() => ({ text: 'slow down' })));
    app.on('spam', async ({ userId }) => void (await app.sendTo(bot, userId, 'muted')));
    bot.on('message', () => undefined);
    await message('1');
    const started = Date.now();
    await message('2');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('concurrent jobs of one update still respect the queue limit', async () => {
    const { app, bot, message } = setup({ queues: { ai: { concurrency: 1 } } });
    let running = 0;
    let max = 0;
    const job = async () => {
      max = Math.max(max, ++running);
      await Bun.sleep(20);
      running--;
    };
    bot.on('message', async (ctx) => void (await Promise.all([app.queue('ai', job, { ctx }), app.queue('ai', job, { ctx })])));
    await message('go');
    expect(max).toBe(1);
  });

  test('a timed-out dialogue replaced by another one reports timeout', async () => {
    const { app, bot, message } = setup({ dialogues: { timeoutMs: 1000 } });
    const reasons: string[] = [];
    app.on('dialogueCancel', ({ reason }) => void reasons.push(reason));
    const a = dialogue('a').steps([{ id: 'x', type: 'text', text: 'x?' }]).onFinish(() => undefined);
    const b = dialogue('b').steps([{ id: 'x', type: 'text', text: 'x?' }]).onFinish(() => undefined);
    app.register(a, b);
    bot.command('a', (ctx) => app.startDialogue(ctx, a));
    bot.command('b', (ctx) => app.startDialogue(ctx, b));
    await message('/a');
    setSystemTime(new Date(Date.now() + 5000));
    try {
      await message('/b');
    } finally {
      setSystemTime();
    }
    expect(reasons).toEqual(['timeout']);
  });
});

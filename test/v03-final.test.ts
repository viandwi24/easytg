import { describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const button = (label: string) =>
    t.calls
      .filter((c) => c.payload.reply_markup?.inline_keyboard)
      .at(-1)!
      .payload.reply_markup.inline_keyboard.flat()
      .find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, button };
}

/** Run the tasks due `ms` from now. */
async function later(app: EasyTG, bot: Parameters<EasyTG['runDueTasks']>[0], ms: number) {
  setSystemTime(new Date(Date.now() + ms));
  try {
    await app.runDueTasks(bot);
  } finally {
    setSystemTime();
  }
}

describe('refreshEveryMs', () => {
  test('stops when anyone shows another page in the message, also for group sends without a user', async () => {
    const { app, bot, press, button, sent, find, reset } = setup({ buttons: { ownerOnly: false } });
    const other = page('other').render(() => ({ text: 'other' }));
    const board = page('board').render(({ nav }) => ({ text: 'board', refreshEveryMs: 5000, keyboard: [[nav.button('away', other)]] }));
    app.register(board, other);
    await app.sendTo(bot, -100, board);
    const messageId = sent.at(-1)!.message_id;
    await press(button('away'), { userId: 8, chatType: 'group', messageId });
    reset();
    await later(app, bot, 6000);
    expect(find('editMessageText')).toEqual([]);
  });

  test('keeps allowedUsers, and a pending deleteAfterMs keeps its deadline', async () => {
    const { app, bot, press, button, sent, find, reset } = setup({ buttons: { params: 'signed', secret: 'x'.repeat(20) } });
    const card = page<{ n?: string }>('card').render(({ params, nav }) => ({
      text: `card ${params.n ?? 0}`,
      refreshEveryMs: 5000,
      deleteAfterMs: 12_000,
      keyboard: [[nav.self('next', { n: String(Number(params.n ?? 0) + 1) })]],
    }));
    app.register(card);
    await app.sendTo(bot, { chatId: -100, allowedUsers: [7, 8] }, card);
    const messageId = sent.at(-1)!.message_id;
    await later(app, bot, 6000); // refresh 1
    const data = button('next');
    reset();
    await press(data, { userId: 8, chatType: 'group', messageId });
    expect(find('editMessageText').map((c) => c.payload.text)).toEqual(['card 1']);
    reset();
    await later(app, bot, 13_000);
    expect(find('deleteMessages').length).toBe(1);
  });
});

describe('loops and leases', () => {
  test('a page and a dialogue that finishes at once redirecting to each other are stopped', async () => {
    const errors: unknown[] = [];
    const { app, press } = setup();
    app.on('error', ({ error }) => void errors.push(error));
    const d = dialogue('d')
      .steps([])
      .onFinish(({ nav }) => nav.redirect('p'));
    const p = page('p').render(({ nav }) => nav.startDialogue(d));
    app.register(p, d);
    await press('p|p');
    expect(String(errors[0])).toMatch(/Too many redirects/);
  });

  test('a broadcastLater batch claimed again is not sent twice', async () => {
    const { app, bot, find } = setup({ scheduler: { leaseMs: 1000 } });
    app.register(page('news').render(() => ({ text: 'news' })));
    await app.broadcastLater([1, 2], page('news'), { perSecond: 1000, botId: 1 });
    const storage = (app as unknown as { scheduler: { store: MemoryStorage } }).scheduler.store;
    await storage.claimTasks(Date.now() + 10, 10, 1); // a process that died holding it
    await later(app, bot, 5000);
    expect(find('sendMessage')).toEqual([]);
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

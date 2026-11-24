// refreshEveryMs: pages that render themselves again.
import { describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions } from '../src';
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

const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

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
  test('the page is rendered again while its message shows it', async () => {
    const { app, bot, message, press, find, sent, reset } = setup();
    let n = 0;
    const status = page('status').render(({ nav }) => ({ text: `n=${++n}`, parseMode: 'plain', refreshEveryMs: 5000, keyboard: [[nav.button('stop', other)]] }));
    const other = page('other').render(() => ({ text: 'other' }));
    app.register(status, other);
    bot.command('s', (ctx) => app.open(ctx, status));
    await message('/s');
    const messageId = sent.at(-1)!.message_id;
    try {
      setSystemTime(new Date(Date.now() + 6000));
      await app.runDueTasks(bot);
      expect(find('editMessageText').map((c) => c.payload.text)).toEqual(['n=2']);

      const stop = find('editMessageText').at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data;
      await press(stop, { messageId });
      reset();
      setSystemTime(new Date(Date.now() + 12_000));
      await app.runDueTasks(bot);
      expect(find('editMessageText')).toEqual([]);
    } finally {
      setSystemTime();
    }
  });
});

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

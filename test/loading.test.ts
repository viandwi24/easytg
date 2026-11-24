// Loading indicators: placeholders, chat actions, app.withLoading.
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

describe('loading', () => {
  const slow = (ms: number, text = 'done') =>
    page(`slow${ms}`)
      .loading({ text: '⏳ Loading…', action: 'typing', afterMs: 20 })
      .render(async () => {
        await Bun.sleep(ms);
        return { text, parseMode: 'plain' };
      });

  test('a slow page shows a placeholder and "typing", then replaces the placeholder', async () => {
    const { app, bot, message, find, sent } = setup();
    const p = slow(80);
    app.register(p);
    bot.command('go', (ctx) => app.open(ctx, p));
    await message('/go');
    expect(find('sendChatAction')[0]!.payload).toMatchObject({ chat_id: 7, action: 'typing' });
    const placeholder = find('sendMessage')[0]!;
    expect(placeholder.payload.text).toBe('⏳ Loading…');
    expect(find('editMessageText')[0]!.payload).toMatchObject({ message_id: sent[0]!.message_id, text: 'done' });
    expect(find('sendMessage').length).toBe(1);
  });

  test('a fast page shows nothing', async () => {
    const { app, bot, message, methods } = setup();
    const p = slow(0);
    app.register(p);
    bot.command('go', (ctx) => app.open(ctx, p));
    await message('/go');
    expect(methods()).toEqual(['sendMessage']);
  });

  test('a pressed menu shows the placeholder until the page replaces it', async () => {
    const { app, press, find } = setup();
    app.register(slow(80));
    await press('p|slow80');
    expect(find('editMessageText').map((c) => c.payload.text)).toEqual(['⏳ Loading…', 'done']);
  });

  test('app.withLoading for your own handlers; the placeholder is removed', async () => {
    const { app, bot, message, find } = setup();
    bot.command('ask', async (ctx) => {
      const answer = await app.withLoading(ctx, () => Bun.sleep(60).then(() => 42), { text: 'Thinking…', afterMs: 10 });
      await ctx.reply(`answer ${answer}`);
    });
    await message('/ask');
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['Thinking…', 'answer 42']);
    expect(find('deleteMessage').length).toBe(1);
  });
});

describe('loading, round 3', () => {
  test('the typing action stops even when the render ends while the toast is being sent', async () => {
    const { app, press, responders, find } = setup();
    responders.answerCallbackQuery = () => Bun.sleep(40).then(() => true) as never;
    app.register(
      page('p')
        .loading({ action: 'typing', toast: 'wait', afterMs: 5 })
        .render(async () => {
          await Bun.sleep(20);
          return { text: 'done' };
        }),
    );
    await press('p|p');
    const before = find('sendChatAction').length;
    await Bun.sleep(4200);
    expect(find('sendChatAction').length).toBe(before);
  }, 8000);

  test('a failed render removes its placeholder, and a pressed menu gets its buttons back', async () => {
    const { app, bot, message, press, find, reset } = setup();
    app.on('error', () => undefined);
    const broken = page('broken')
      .loading({ text: 'Loading…', afterMs: 5 })
      .render(async () => {
        await Bun.sleep(30);
        throw new Error('boom');
      });
    app.register(broken);
    bot.command('go', (ctx) => app.open(ctx, broken).catch(() => undefined));
    await message('/go');
    expect(find('deleteMessage').length).toBe(1);

    reset();
    const keyboard = { inline_keyboard: [[{ text: 'again', callback_data: 'p|broken' }]] };
    await press('p|broken', { message: { text: 'Menu', reply_markup: keyboard } });
    expect(find('editMessageText').map((c) => c.payload.text)).toEqual(['Loading…', 'Menu']);
    expect(find('editMessageText')[1]!.payload.reply_markup).toEqual(keyboard);
  });

  test('dialogue loading after a button answer uses a new placeholder that the result replaces', async () => {
    const { app, bot, message, press, find, sent } = setup();
    const d = dialogue('d')
      .loading({ text: 'Saving…', afterMs: 5 })
      .steps([{ id: 'ok', type: 'choice', text: 'OK?', options: [{ text: 'Yes', value: 'y' }] }])
      .onFinish(async () => {
        await Bun.sleep(30);
        return { text: 'saved', parseMode: 'plain' };
      });
    app.register(d);
    bot.command('go', (ctx) => app.startDialogue(ctx, d));
    await message('/go');
    const data = find('sendMessage')[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data;
    await press(data, { messageId: sent.at(-1)!.message_id });
    const placeholder = find('sendMessage').find((c) => c.payload.text === 'Saving…');
    expect(placeholder).toBeDefined();
    expect(find('editMessageText').map((c) => c.payload.text)).toContain('saved');
  });

  test('two opens in one update: the second is not treated as navigation from the placeholder', async () => {
    const storage = new MemoryStorage();
    const { app, bot, message } = setup({ storage });
    const slow = page('slowA').loading({ text: '…', afterMs: 5 }).render(async () => (await Bun.sleep(30), { text: 'A' }));
    const b = page('b').render(({ nav }) => ({ text: 'B', keyboard: [[nav.back()]] }));
    app.register(slow, b);
    bot.command('go', async (ctx) => {
      await app.open(ctx, slow);
      await app.open(ctx, b);
    });
    await message('/go');
    const nav = ((await storage.get('session:1:7:7')) as { data: { '_easytg:nav': Record<string, { current: { id: string }; stack: unknown[] }> } }).data[
      '_easytg:nav'
    ];
    const entries = Object.values(nav);
    expect(entries.map((e) => e.current.id).sort()).toEqual(['b', 'slowA']);
    expect(entries.find((e) => e.current.id === 'b')!.stack).toEqual([]);
  });
});

test('throttle: an album larger than the limit goes out in one window', async () => {
  const { app, bot } = setup();
  bot.api.config.use(app.throttle({ privateChat: { limit: 1, perMs: 1000 }, maxWaitMs: 3000 }));
  const started = Date.now();
  await bot.api.sendMediaGroup(7, [
    { type: 'photo', media: 'a' },
    { type: 'photo', media: 'b' },
  ]);
  expect(Date.now() - started).toBeLessThan(1500);
});

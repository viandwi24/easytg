import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

describe('merged sessions', () => {
  test('a migration is saved even when only one key changes', async () => {
    const storage = new MemoryStorage();
    await storage.set('usersession:1:7', { data: { old: 1 }, meta: { v: 1, savedAt: 1, app: 1 } });
    const { app, bot, message } = setup({ storage, session: { version: 2, migrate: (d) => ({ renamed: d.old }) } });
    bot.on('message', async (ctx) => (await app.userSession(ctx)).set('x', 1));
    await message('hi');
    expect(await storage.get('usersession:1:7')).toMatchObject({ data: { renamed: 1, x: 1 }, meta: { app: 2 } });
    expect(((await storage.get('usersession:1:7')) as { data: object }).data).not.toHaveProperty('old');
  });

  test("a save without changes doesn't bring back what others changed or deleted", async () => {
    const storage = new MemoryStorage();
    const { app, bot, message } = setup({ storage, session: { ttlMs: 1000 } });
    await storage.set('usersession:1:7', { data: { a: 1 }, meta: { v: 1, savedAt: 1 } }); // due for a TTL refresh
    bot.on('message:text', async (ctx) => {
      await app.userSession(ctx);
      if (ctx.message.text === 'slow') await Bun.sleep(30);
      else await storage.set('usersession:1:7', { data: { a: 1, plan: 'pro' }, meta: { v: 1, savedAt: Date.now() } });
    });
    await Promise.all([message('slow'), Bun.sleep(5).then(() => message('other', { chatId: 99 }))]);
    expect(await storage.get('usersession:1:7')).toMatchObject({ data: { plan: 'pro' } });
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

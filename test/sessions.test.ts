// Chat, user and per-chat sessions: sharing, merging, migrations, navigation.
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, page, type EasyTGOptions, dialogue } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const buttons = () => t.calls.filter((c) => c.payload.reply_markup?.inline_keyboard).at(-1)!.payload.reply_markup.inline_keyboard.flat();
  const button = (label: string) => buttons().find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, buttons, button };
}

const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

describe('chat sessions', () => {
  test('shared by the users of a chat, saved with the update', async () => {
    const storage = new MemoryStorage();
    const { app, bot, message } = setup({ storage });
    bot.command('add', async (ctx) => {
      const chat = await app.chatSession(ctx);
      chat.set('players', [...(chat.get<number[]>('players') ?? []), ctx.from!.id]);
    });
    await message('/add', { userId: 1, chatType: 'group' });
    await message('/add', { userId: 2, chatType: 'group' });
    expect(await storage.get('chatsession:1:-100')).toMatchObject({ data: { players: [1, 2] } });
  });
});

describe('session migrations', () => {
  test('stored sessions are migrated once, new ones start at the current version', async () => {
    const storage = new MemoryStorage();
    await storage.set('session:1:7:7', { data: { cart: 'tea' }, meta: { v: 1, savedAt: 1 } });
    const { bot, message, app } = setup({
      storage,
      session: { version: 2, migrate: (data, from) => (from < 2 ? { cart: [data.cart] } : data) },
    });
    let cart: unknown;
    bot.command('cart', async (ctx) => void (cart = (await app.session(ctx)).get('cart')));
    await message('/cart');
    expect(cart).toEqual(['tea']);
    expect(await storage.get('session:1:7:7')).toMatchObject({ data: { cart: ['tea'] }, meta: { app: 2 } });
    await message('/cart');
    expect(cart).toEqual(['tea']);
    expect(() => new EasyTG({ session: { migrate: (d) => d } })).toThrow(/session.version/);
  });
});

describe('chat and user sessions', () => {
  test('userSession follows the user across chats; session and dialogues stay per chat', async () => {
    const storage = new MemoryStorage();
    const { app, bot, message, find } = setup({ storage });
    const ask = dialogue<{ a: string }>('ask')
      .steps([{ id: 'a', type: 'text', text: 'a?' }])
      .onFinish(async ({ ctx, answers, app }) => {
        (await app.userSession(ctx)).set('answer', answers.a);
        return { text: 'saved', parseMode: 'plain' };
      });
    app.register(ask);
    let seen: unknown;
    bot.command('ask', (ctx) => app.startDialogue(ctx, ask));
    bot.command('show', async (ctx) => void (seen = (await app.userSession(ctx)).get('answer')));
    const texts: string[] = [];
    bot.on('message:text', (ctx) => void texts.push(ctx.message.text));

    await message('/ask', { chatType: 'group' });
    await message('from private'); // not an answer: the dialogue is in the group
    expect(texts).toEqual(['from private']);
    await message('42', { chatType: 'group' });
    await message('/show'); // private chat
    expect(seen).toBe('42');
    expect(await storage.get('usersession:1:7')).toMatchObject({ data: { answer: '42' } });
    expect(find('sendMessage').at(-1)!.payload.text).toBe('saved');
  });

  test("'chat' (default): per chat, with userSession for what follows the user", async () => {
    const { app, bot, message } = setup();
    let chat: unknown;
    let user: unknown;
    bot.command('set', async (ctx) => {
      (await app.session(ctx)).set('x', 1);
      (await app.userSession(ctx)).set('lang', 'id');
    });
    bot.command('get', async (ctx) => {
      chat = (await app.session(ctx)).get('x');
      user = (await app.userSession(ctx)).get('lang');
    });
    await message('/set', { chatType: 'group' });
    await message('/get');
    expect(chat).toBeUndefined();
    expect(user).toBe('id');
  });

  test('updates in two chats at once keep both changes of the user session (merged per key)', async () => {
    const storage = new MemoryStorage();
    const { app, bot, message } = setup({ storage });
    bot.on('message:text', async (ctx) => {
      const user = await app.userSession(ctx);
      await Bun.sleep(20); // both updates have loaded the session now
      user.set(ctx.message.text, true);
    });
    await Promise.all([message('fromPrivate'), message('fromGroup', { chatType: 'group' })]);
    expect(await storage.get('usersession:1:7')).toMatchObject({ data: { fromPrivate: true, fromGroup: true } });
  });

  test('chat sessions merge changes of users acting at the same time', async () => {
    const storage = new MemoryStorage();
    const { app, bot, message } = setup({ storage });
    bot.on('message:text', async (ctx) => {
      const chat = await app.chatSession(ctx);
      await Bun.sleep(20);
      chat.set(`vote:${ctx.from.id}`, ctx.message.text);
    });
    await Promise.all([message('yes', { userId: 1, chatType: 'group' }), message('no', { userId: 2, chatType: 'group' })]);
    expect(await storage.get('chatsession:1:-100')).toMatchObject({ data: { 'vote:1': 'yes', 'vote:2': 'no' } });
  });

  test('the language chosen with setLocale applies in every chat', async () => {
    const { app, bot, message, find, reset } = setup({ i18n: { messages: { en: { hi: 'Hi' }, id: { hi: 'Halo' } } } });
    bot.command('id', async (ctx) => app.setLocale(ctx, 'id'));
    bot.command('hi', async (ctx) => void (await ctx.reply((await app.session(ctx), app.t(ctx)('hi')))));
    await message('/id', { language: 'en' });
    reset();
    await message('/hi', { chatType: 'group', language: 'en' });
    expect(find('sendMessage')[0]!.payload.text).toBe('Halo');
  });
});

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

describe('sessions and navigation', () => {
  test('sendTo from a handler of the same user shares its session', async () => {
    const { app, bot, message, find, reset } = setup();
    const search = page('search')
      .render(() => ({ text: 'type' }))
      .onText(({ text }) => ({ text: `got ${text}`, parseMode: 'plain' }));
    app.register(search);
    bot.command('go', async (ctx) => {
      (await app.session(ctx)).set('x', 1);
      await app.sendTo(bot, ctx.chat.id, search);
    });
    let x: unknown;
    bot.command('x', async (ctx) => void (x = (await app.session(ctx)).get('x')));
    await message('/go');
    reset();
    await message('hello');
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['got hello']);
    await message('/x');
    expect(x).toBe(1);
  });

  for (const params of ['stored', 'signed', 'auto'] as const) {
    test(`an allowedUsers menu stays shared after a press (${params})`, async () => {
      const { app, bot, press, button, sent, find, reset } = setup({ buttons: { params, secret: 'x'.repeat(20) } });
      const card = page<{ n: string }>('card').render(({ params, nav }) => ({
        text: `card ${params.n}`,
        keyboard: [[nav.button('next', card, { n: String(Number(params.n) + 1) })]],
      }));
      app.register(card);
      await app.sendTo(bot, { chatId: -100, allowedUsers: [7, 8] }, card, { n: '1' });
      const messageId = sent.at(-1)!.message_id;
      await press(button('next'), { userId: 7, chatType: 'group', messageId });
      const next = button('next');
      reset();
      await press(next, { userId: 8, chatType: 'group', messageId });
      expect(find('editMessageText').map((c) => c.payload.text)).toEqual(['card 3']);
      const third = button('next');
      reset();
      await press(third, { userId: 9, chatType: 'group', messageId });
      expect(find('answerCallbackQuery')[0]!.payload.text).toBe(app.texts.notYourMenu);
    });
  }

  test("a dialogue's onFinish redirect is recorded like any page view", async () => {
    const { app, bot, message, find, reset } = setup();
    const views: string[] = [];
    app.on('pageView', ({ page }) => void views.push(page));
    const search = page('search')
      .render(() => ({ text: 'type', parseMode: 'plain' }))
      .onText(({ text }) => ({ text: `got ${text}`, parseMode: 'plain' }));
    const ask = dialogue<{ q: string }>('ask')
      .steps([{ id: 'q', type: 'text', text: 'q?' }])
      .onFinish(({ nav }) => nav.redirect(search));
    app.register(search, ask);
    bot.command('ask', (ctx) => app.startDialogue(ctx, ask));
    await message('/ask');
    await message('first');
    expect(views).toEqual(['search']);
    reset();
    await message('tea');
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['got tea']);
  });

  test('closing a page ends its text input', async () => {
    const { app, bot, message, press, button, sent } = setup();
    const search = page('search')
      .render(({ nav }) => ({ text: 'type', keyboard: [[nav.close()]] }))
      .onText(({ text }) => ({ text: `got ${text}` }));
    app.register(search);
    const seen: string[] = [];
    bot.command('search', (ctx) => app.open(ctx, search));
    bot.on('message:text', (ctx) => void seen.push(ctx.message.text));
    await message('/search');
    await press(button('Close'), { messageId: sent.at(-1)!.message_id });
    await message('hello');
    expect(seen).toEqual(['hello']);
  });

  test('params: false is dropped, and dialogue params are always strings', async () => {
    const { app, bot, message } = setup();
    let got: unknown;
    const d = dialogue<{ a: string }, { id: string; archived?: string }>('d')
      .steps(({ params }) => ((got = params), [{ id: 'a', type: 'text', text: 'a?' }]))
      .onFinish(() => undefined);
    const p = page('p').render(({ nav }) => nav.startDialogue(d, { id: 42 as never, archived: false as never }));
    app.register(d, p);
    bot.command('p', (ctx) => app.open(ctx, p));
    await message('/p');
    expect(got).toEqual({ id: '42' });
  });
});

import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

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

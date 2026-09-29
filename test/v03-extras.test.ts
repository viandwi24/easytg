import { describe, expect, setSystemTime, test } from 'bun:test';
import type { InlineQueryResult } from 'grammy/types';
import { EasyTG, MemoryStorage, page, requireChatAdmin, type EasyTGOptions, type EasyTGEvents } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
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

describe('observability', () => {
  test('update and pageView events carry timings and outcomes', async () => {
    const { app, bot, message, press } = setup({ antiSpam: { limit: 2, warn: false } });
    app.register(page('home').render(() => ({ text: 'home' })));
    const updates: EasyTGEvents['update'][] = [];
    const views: EasyTGEvents['pageView'][] = [];
    app.on('update', (e) => void updates.push(e));
    app.on('pageView', (e) => void views.push(e));
    bot.on('message', () => undefined);
    await press('p|home');
    await message('hi');
    await message('flood');
    expect(updates.map((u) => u.outcome)).toEqual(['easytg', 'next', 'limited']);
    expect(updates.every((u) => u.durationMs >= 0)).toBe(true);
    expect(views[0]).toMatchObject({ page: 'home', chatId: 7, userId: 7, mode: 'edit' });
    expect(views[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('file id cache', () => {
  test('a photo sent by URL is sent by file id next time', async () => {
    const { app, bot, message, responders, find } = setup({ media: { cacheFileIds: true } });
    responders.sendPhoto = (p) => ({ message_id: 9, date: 1, chat: { id: p.chat_id, type: 'private' }, photo: [{ file_id: 'small' }, { file_id: 'BIG' }] });
    app.register(page('pic').render(() => ({ photo: 'https://example.com/cat.jpg', text: 'cat' })));
    bot.command('pic', (ctx) => app.open(ctx, 'pic'));
    await message('/pic');
    await message('/pic');
    expect(find('sendPhoto').map((c) => c.payload.photo)).toEqual(['https://example.com/cat.jpg', 'BIG']);
  });
});

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

describe('inline mode', () => {
  test('pages become inline results whose buttons work in the sent message', async () => {
    const { app, bot, update, press, find } = setup({ buttons: { params: 'stored' } });
    const product = page<{ id: string }>('product').render(({ params, nav }) => ({
      text: `Product ${params.id}`,
      parseMode: 'plain',
      keyboard: [[nav.self('Refresh', { id: params.id })]],
    }));
    app.register(product);
    let results: InlineQueryResult[] = [];
    bot.on('inline_query', async (ctx) => {
      results = [await app.inlineResult(ctx, product, { params: { id: '7' }, title: 'Product 7' })];
    });
    await update({ inline_query: { id: 'q', from: user(7), query: 'p', offset: '' } });
    const article = results[0] as Extract<InlineQueryResult, { type: 'article' }>;
    expect(article).toMatchObject({ type: 'article', title: 'Product 7', input_message_content: { message_text: 'Product 7' } });

    const data = article.reply_markup!.inline_keyboard[0]![0]! as { callback_data: string };
    await update({ callback_query: { id: 'c', from: user(8), chat_instance: 'x', inline_message_id: 'IM', data: data.callback_data } });
    expect(find('editMessageText')[0]!.payload).toMatchObject({ inline_message_id: 'IM', text: 'Product 7' });
  });
});

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

describe('requireChatAdmin', () => {
  test('only admins pass in groups; private chats pass', async () => {
    const { app, press, responders, find } = setup();
    responders.getChatMember = (p) => ({ status: p.user_id === 1 ? 'administrator' : 'member', user: user(p.user_id) });
    const views: string[] = [];
    app.on('pageView', ({ page }) => void views.push(page));
    app.register(page('settings').use(requireChatAdmin()).render(() => ({ text: 'settings' })));
    await press('p|settings', { userId: 2, chatType: 'group' });
    expect(find('answerCallbackQuery').at(-1)!.payload.text).toBe(app.texts.adminOnly);
    await press('p|settings', { userId: 1, chatType: 'group', messageId: 501 });
    await press('p|settings', { userId: 2, messageId: 502 });
    expect(views).toEqual(['settings', 'settings']);
  });
});

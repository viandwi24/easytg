// Delivery modes, bot-scoped keys, copy/protectContent, app.edit, `sent`,
// prepareProactive, params parsing, signed buttons, error helpers, allowedUsers.
import { describe, expect, test } from 'bun:test';
import {
  EasyTG,
  InvalidParamsError,
  MemoryStorage,
  isChatUnreachable,
  isMessageNotFound,
  page,
  retryAfterMs,
  type EasyTGOptions,
  type StorageAdapter,
} from '../src';
import { createTestBot, telegramError, type TestBotOptions } from '../src/testing';

function setup(options: EasyTGOptions = {}, bot: TestBotOptions = {}) {
  const t = createTestBot(bot);
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const errors: unknown[] = [];
  app.on('error', ({ error }) => void errors.push(error));
  return { ...t, app, errors };
}
const videoMessage = { text: undefined, video: { file_id: 'VID' } };
const buttons = (payload: any): string[] => payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

describe('1. keeping the pressed message', () => {
  function setupVideo(options: EasyTGOptions = {}) {
    const t = setup(options);
    const list = page<{ from?: string }>('list').render(({ params }) => ({ text: `list from ${params.from ?? '-'}` }));
    const lesson = page('lesson').render(({ nav }) => ({
      video: 'VID',
      text: 'Lesson 1',
      keyboard: [[nav.button('All lessons', list, { from: 'video' }, { mode: 'send' })], [nav.button('Plain', list)]],
    }));
    t.app.register(list, lesson);
    return t;
  }

  test("{ mode: 'send' } leaves the pressed message untouched", async () => {
    const t = setupVideo();
    await t.press('p|lesson');
    const [send] = buttons(t.find('editMessageMedia')[0]!.payload);
    expect(send).toBe('p|list|from=video&_m=s');
    t.reset();
    await t.press(send!, { message: videoMessage });
    expect(t.methods()).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(t.find('sendMessage')[0]!.payload.text).toBe('list from video'); // `_m` isn't a page param
  });

  test("mediaToText: 'keep' only strips the buttons of the media message", async () => {
    const t = setupVideo({ buttons: { mediaToText: 'keep' } });
    await t.press('p|list', { message: videoMessage });
    expect(t.methods()).toEqual(['editMessageReplyMarkup', 'sendMessage', 'answerCallbackQuery']);
    expect(t.find('editMessageReplyMarkup')[0]!.payload.reply_markup).toEqual({ inline_keyboard: [] });
  });

  test("default 'replace' deletes it", async () => {
    const t = setupVideo();
    await t.press('p|list', { message: videoMessage });
    expect(t.methods()).toContain('deleteMessage');
  });

  test('param names starting with "_" are reserved', async () => {
    const t = setup();
    t.app.register(page('x').render(({ nav }) => ({ text: 'x', keyboard: [[nav.self('bad', { _m: 's' })]] })));
    await t.press('p|x');
    expect(String(t.errors[0])).toContain('reserved');
  });
});

describe('2. storage keys per bot', () => {
  function twoBots(options: EasyTGOptions = {}) {
    const storage = new MemoryStorage();
    const make = (id: number) => {
      const t = setup({ storage, ...options }, { botInfo: { id, username: `bot${id}` } });
      t.bot.command('set', async (ctx) => (await t.app.session(ctx)).set('v', `from bot ${id}`));
      let seen: unknown;
      t.bot.command('get', async (ctx) => void (seen = (await t.app.session(ctx)).get('v')));
      return { ...t, seen: () => seen };
    };
    return [make(1), make(2)] as const;
  }

  test('sessions of two bots sharing a storage stay apart', async () => {
    const [a, b] = twoBots();
    await a.message('/set');
    await b.message('/get');
    expect(b.seen()).toBeUndefined();
    await a.message('/get');
    expect(a.seen()).toBe('from bot 1');
  });

  test('scopeKeysByBot: false shares them (0.1 key format)', async () => {
    const [a, b] = twoBots({ scopeKeysByBot: false });
    await a.message('/set');
    await b.message('/get');
    expect(b.seen()).toBe('from bot 1');
  });

  test('stored deep links work across bots', async () => {
    const storage = new MemoryStorage();
    const promo = page<{ code: string }>('promo').allowDeepLink().render(({ params }) => ({ text: `promo ${params.code}` }));
    const make = (id: number) => {
      const t = setup({ storage }, { botInfo: { id, username: `bot${id}` } });
      t.app.register(promo);
      return t;
    };
    const [a, b] = [make(1), make(2)];
    const url = await a.app.deepLink(a.bot, promo, { code: 'x'.repeat(80) });
    await b.message(`/start ${new URL(url).searchParams.get('start')}`);
    expect(b.find('sendMessage')[0]!.payload.text).toBe(`promo ${'x'.repeat(80)}`);
  });
});

describe('3. copy and protectContent', () => {
  test('copy a message from a storage channel, with a new caption and buttons', async () => {
    const t = setup({ protectContent: true });
    const sent: number[][] = [];
    t.app.on('sent', ({ messageIds }) => void sent.push(messageIds));
    const lesson = page<{ n: string }>('lesson').render(({ params, nav }) => ({
      copy: { fromChatId: -1001234, messageId: Number(params.n) },
      text: `**Lesson ${params.n}**`,
      keyboard: [[nav.self('Next', { n: Number(params.n) + 1 })]],
    }));
    const menu = page('menu').render(() => ({ text: 'menu' }));
    t.app.register(lesson, menu);

    await t.press('p|lesson|n=7'); // from a text menu: the menu is replaced by the copy
    const [copy] = t.find('copyMessage');
    expect(copy!.payload).toMatchObject({
      chat_id: 7,
      from_chat_id: -1001234,
      message_id: 7,
      caption: '<b>Lesson 7</b>',
      parse_mode: 'HTML',
      protect_content: true,
    });
    expect(buttons(copy!.payload)).toEqual(['p|lesson|n=8']);
    expect(t.methods()).toContain('deleteMessage');
    expect(sent).toHaveLength(1);

    t.reset();
    await t.press('p|menu', { messageId: 2 });
    expect(t.find('editMessageText')[0]!.payload.protect_content).toBeUndefined(); // edits have no such option
  });

  test('without text the original caption stays; pages can opt out of protection', async () => {
    const t = setup({ protectContent: true });
    t.app.register(
      page('raw').render(() => ({ copy: { fromChatId: '@archive', messageId: 3 }, protectContent: false })),
      page('text').render(() => ({ text: 'hello' })),
    );
    t.bot.command('raw', (ctx) => t.app.open(ctx, 'raw'));
    t.bot.command('text', (ctx) => t.app.open(ctx, 'text'));
    await t.message('/raw');
    await t.message('/text');
    const [copy] = t.find('copyMessage');
    expect(copy!.payload.caption).toBeUndefined();
    expect(copy!.payload.protect_content).toBeUndefined();
    expect(t.find('sendMessage')[0]!.payload.protect_content).toBe(true);
  });
});

describe('4. testing kit', () => {
  test('copy/forward calls get realistic results; bot identity is configurable', async () => {
    const t = createTestBot({ botInfo: { id: 42, username: 'custom_bot' } });
    expect(t.bot.botInfo).toMatchObject({ id: 42, username: 'custom_bot' });
    const copy = await t.bot.api.copyMessage(1, 2, 3);
    expect(copy).toEqual({ message_id: expect.any(Number) });
    const many = await t.bot.api.copyMessages(1, 2, [3, 4, 5]);
    expect(many).toHaveLength(3);
    const forwarded = await t.bot.api.forwardMessage(1, 2, 3);
    expect(forwarded.message_id).toBeNumber();
  });
});

describe('5. app.edit', () => {
  test('re-renders a page into an existing message', async () => {
    const t = setup();
    const card = page<{ status: string }>('card').render(({ params, nav }) => ({
      text: `Status: ${params.status}`,
      keyboard: [[nav.self('Refresh', { status: params.status })]],
    }));
    t.app.register(card);
    await t.app.edit(t.bot, { chatId: -100, messageId: 55 }, card, { status: 'approved' });
    expect(t.find('editMessageText')[0]!.payload).toMatchObject({ chat_id: -100, message_id: 55, text: 'Status: approved' });
  });

  test('media messages get their caption edited; missing messages are not re-sent', async () => {
    const t = setup();
    t.app.register(page('card').render(() => ({ text: 'updated' })));
    t.responders.editMessageText = () => telegramError('Bad Request: there is no text in the message to edit');
    await t.app.edit(t.bot, { chatId: 5, messageId: 9 }, 'card');
    expect(t.find('editMessageCaption')[0]!.payload).toMatchObject({ message_id: 9, caption: 'updated' });

    t.responders.editMessageText = () => telegramError('Bad Request: message to edit not found');
    const result = await t.app.edit(t.bot, { chatId: 5, messageId: 10 }, 'card');
    expect(result).toBeUndefined();
    expect(t.find('sendMessage')).toHaveLength(0);
  });
});

describe('6. sent event', () => {
  test('reports every message id of a split page', async () => {
    const t = setup();
    const events: { chatId: number; messageIds: number[]; page?: string }[] = [];
    t.app.on('sent', ({ chatId, messageIds, page }) => void events.push({ chatId, messageIds, page }));
    const long = page('long').render(() => ({ text: Array.from({ length: 150 }, () => 'x'.repeat(40)) }));
    t.app.register(long);
    await t.app.sendTo(t.bot, 7, long);
    expect(events).toEqual([{ chatId: 7, messageIds: t.sent.map((m) => m.message_id), page: 'long' }]);
    expect(events[0]!.messageIds).toHaveLength(2);
  });
});

describe('7. prepareProactive', () => {
  test('adds what middlewares normally put on ctx, for sendTo and broadcast', async () => {
    type Ctx = import('grammy').Context & { user?: { name: string } };
    const users: Record<number, string> = { 1: 'Ann', 2: 'Bob' };
    const t = createTestBot<Ctx>();
    const app = new EasyTG<Ctx>({
      logger: false,
      prepareProactive: async (ctx) => void (ctx.user = { name: users[ctx.from!.id]! }),
    });
    const hello = page<{}, Ctx>('hello').render(({ ctx }) => ({ text: `Hi ${ctx.user?.name}` }));
    app.register(hello);
    await app.sendTo(t.bot, 1, hello);
    await app.broadcast(t.bot, [2], hello, { perSecond: 1000 });
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual(['Hi Ann', 'Hi Bob']);
  });
});

describe('8. params parsing', () => {
  const toInt = (value: string | undefined) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new InvalidParamsError(`not a positive integer: ${value}`);
    return n;
  };

  test('render gets converted params; invalid ones show "page not found"', async () => {
    const t = setup();
    let seen: unknown;
    const episode = page<{ id: string }>('episode')
      .params((raw) => ({ id: toInt(raw.id) }))
      .render(({ params, nav }) => {
        seen = params;
        const next: number = params.id + 1; // params.id is a number here
        return { text: `episode ${params.id}`, keyboard: [[nav.button('Next', episode, { id: next })]] };
      });
    t.app.register(episode);

    await t.press('p|episode|id=4');
    expect(seen).toEqual({ id: 4 });
    expect(buttons(t.find('editMessageText')[0]!.payload)).toEqual(['p|episode|id=5']);

    t.reset();
    await t.press('p|episode|id=abc', { messageId: 2 });
    expect(t.find('answerCallbackQuery')[0]!.payload).toMatchObject({ text: t.app.texts.pageNotFound, show_alert: true });
    expect(t.errors).toEqual([]); // rejected input is not an app error

    await expect(t.app.open({ me: { id: 1 }, chat: { id: 1 }, from: { id: 1 } } as any, episode, { id: '0' })).rejects.toBeInstanceOf(
      InvalidParamsError,
    );
  });

  test('any thrown error counts as invalid params', async () => {
    const t = setup();
    t.app.register(page<{ d: string }>('date').params((raw) => ({ d: JSON.parse(raw.d) })).render(() => ({ text: 'ok' })));
    await t.press('p|date|d=%7Bbroken');
    expect(t.find('answerCallbackQuery')[0]!.payload.text).toBe(t.app.texts.pageNotFound);
  });
});

describe('9. signed buttons', () => {
  const secret = 'a-long-enough-secret-value';
  function counting(): StorageAdapter & { writes: string[] } {
    const inner = new MemoryStorage();
    const writes: string[] = [];
    return { writes, get: (k) => inner.get(k), set: (k, v, ttl) => (writes.push(k), inner.set(k, v, ttl)), delete: (k) => inner.delete(k) };
  }

  function setupSigned() {
    const storage = counting();
    const t = setup({ storage, buttons: { params: 'signed', secret } });
    const seen: unknown[] = [];
    const order = page<{ id: string }>('order').render(({ params, nav }) => {
      seen.push(params);
      return { text: `order ${params.id}`, keyboard: [[nav.self('next', { id: Number(params.id) + 1 })]] };
    });
    t.app.register(order);
    return { ...t, storage, seen };
  }

  test('params stay inline with a signature; nothing is written to storage for buttons', async () => {
    const t = setupSigned();
    t.bot.command('go', (ctx) => t.app.open(ctx, 'order', { id: '1' }));
    await t.message('/go');
    const [next] = buttons(t.find('sendMessage')[0]!.payload);
    expect(next).toMatch(/^p\|order\|id=2&_s=u[A-Za-z0-9_-]{11}$/);
    await t.press(next!);
    expect(t.seen.at(-1)).toEqual({ id: '2' }); // `_s` isn't a page param
    expect(t.storage.writes.filter((k) => k.startsWith('cb:'))).toEqual([]);
  });

  test('tampered, unsigned or foreign signatures are rejected', async () => {
    const t = setupSigned();
    t.bot.command('go', (ctx) => t.app.open(ctx, 'order', { id: '1' }));
    await t.message('/go');
    const [next] = buttons(t.find('sendMessage')[0]!.payload);
    for (const [data, userId] of [
      [next!.replace('id=2', 'id=999'), 7], // tampered
      ['p|order|id=2', 7], // unsigned
      [next!, 8], // signed for user 7, pressed by user 8
    ] as const) {
      t.reset();
      await t.press(data, { userId });
      expect(t.find('answerCallbackQuery')[0]!.payload.text).toBe(t.app.texts.buttonExpired);
    }
    expect(t.seen).toEqual([{ id: '1' }]);
  });

  test('deep links are signed too, without being bound to a user or bot', async () => {
    const t = setup({ buttons: { params: 'signed', secret } });
    const promo = page<{ code: string }>('promo').allowDeepLink().render(({ params }) => ({ text: `promo ${params.code}` }));
    t.app.register(promo);
    const payload = new URL(await t.app.deepLink(t.bot, promo, { code: 'SALE' })).searchParams.get('start')!;
    await t.message(`/start ${payload}`, { userId: 99 });
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('promo SALE');
    const forged = `_i${Buffer.from('promo|code=FREE').toString('base64url')}`;
    let fallback = 0;
    t.bot.command('start', () => void fallback++);
    await t.message(`/start ${forged}`);
    expect(fallback).toBe(1);
  });

  test('a secret is required', () => {
    expect(() => new EasyTG({ buttons: { params: 'signed' } })).toThrow(/secret/);
    expect(() => new EasyTG({ buttons: { params: 'signed', secret: 'short' } })).toThrow(/16 characters/);
  });
});

describe('11. error helpers', () => {
  test('classify common Telegram errors', () => {
    expect(isChatUnreachable(telegramError('Forbidden: bot was blocked by the user', { code: 403 }))).toBe(true);
    expect(isChatUnreachable(telegramError('Bad Request: chat not found'))).toBe(true);
    expect(isChatUnreachable(telegramError('Bad Request: message is not modified'))).toBe(false);
    expect(isMessageNotFound(telegramError('Bad Request: message to delete not found'))).toBe(true);
    expect(retryAfterMs(telegramError('Too Many Requests', { code: 429, retryAfter: 5 }))).toBe(5000);
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
  });
});

describe('12. allowedUsers', () => {
  test('only the listed users may press a card sent to a group', async () => {
    for (const params of ['auto', 'stored', 'signed'] as const) {
      const t = setup({ buttons: { params, secret: 'a-long-enough-secret-value' } });
      const pressed: number[] = [];
      const card = page<{ id: string }>('card').render(({ ctx, params: p, nav }) => {
        if (ctx.callbackQuery) pressed.push(ctx.from!.id);
        return { text: `card ${p.id}`, keyboard: [[nav.self('Approve', { id: p.id })]] };
      });
      t.app.register(card);
      await t.app.sendTo(t.bot, { chatId: -100, allowedUsers: [5, 6] }, card, { id: '1' });
      const data = buttons(t.find('sendMessage')[0]!.payload)[0]!;
      const messageId = t.sent.at(-1)!.message_id;
      for (const userId of [5, 6, 7]) await t.press(data, { userId, chatType: 'group', messageId });
      expect({ params, pressed }).toEqual({ params, pressed: [5, 6] });
    }
  });
});

describe('link buttons', () => {
  test('URLs Telegram rejects fail early with a clear error', async () => {
    const t = setup();
    t.app.register(
      page('ok').render(({ nav }) => ({ text: 'ok', keyboard: [[nav.url('Site', 'https://example.com'), nav.url('User', 'tg://user?id=1')]] })),
      page('mail').render(({ nav }) => ({ text: 'x', keyboard: [[nav.url('Mail', 'mailto:a@b.c')]] })),
      page('app').render(({ nav }) => ({ text: 'x', keyboard: [[nav.webApp('App', 'http://insecure.example')]] })),
    );
    await t.press('p|ok');
    await t.press('p|mail', { messageId: 2 });
    await t.press('p|app', { messageId: 3 });
    expect(t.find('editMessageText')).toHaveLength(1);
    expect(t.errors.map(String)).toEqual([expect.stringContaining('http(s):// and tg://'), expect.stringContaining('https://')]);
  });
});

describe('0.2.1', () => {
  test('sendTo / edit errors reach the error event with emitProactiveErrors (and are still thrown)', async () => {
    const t = setup({ emitProactiveErrors: true });
    const events: string[] = [];
    t.app.on('error', ({ source }) => void events.push(source));
    t.app.register(page('p').render(() => ({ text: 'x' })));
    t.responders.sendMessage = () => telegramError('Forbidden: bot was blocked by the user', { code: 403 });
    await expect(t.app.sendTo(t.bot, 5, 'p')).rejects.toThrow();
    t.responders.editMessageText = () => telegramError('Bad Request: something odd');
    await expect(t.app.edit(t.bot, { chatId: 5, messageId: 1 }, 'p')).rejects.toThrow();
    // broadcast failures are reported in its result, not as error events
    const news = page('news').render(() => ({ text: 'news' }));
    t.app.register(news);
    const result = await t.app.broadcast(t.bot, [5, 6], news, { perSecond: 1000 });
    expect(result.blocked).toBe(2);
    expect(events).toEqual(['sendTo', 'edit']);
  });

  test('no "no user" warning for sendTo to a group without a user', async () => {
    const warnings: string[] = [];
    const t = createTestBot();
    const app = new EasyTG({ logger: { debug() {}, info() {}, warn: (m) => void warnings.push(m), error() {} } });
    app.register(page('g').render(() => ({ text: 'hello group' })));
    await app.sendTo(t.bot, -100, 'g');
    expect(t.find('sendMessage')).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test('busy, double-tap and anti-spam state is per bot', async () => {
    const storage = new MemoryStorage();
    const make = (id: number) => {
      const t = setup({ storage, antiSpam: { limit: 2 }, buttons: { doubleTapMs: 1000 } }, { botInfo: { id } });
      let renders = 0;
      t.app.register(page('p').render(() => ((renders++), { text: 'p' })));
      return { ...t, renders: () => renders };
    };
    const [a, b] = [make(1), make(2)];
    // the same button data and message id on two bots is not a double tap
    await a.press('p|p', { messageId: 5 });
    await b.press('p|p', { messageId: 5 });
    expect([a.renders(), b.renders()]).toEqual([1, 1]);

    // one app instance serving two bots: limits are counted per bot
    const app = new EasyTG({ logger: false, antiSpam: { limit: 1 } });
    const one = createTestBot({ botInfo: { id: 1 } });
    const two = createTestBot({ botInfo: { id: 2 } });
    one.bot.use(app);
    two.bot.use(app);
    let handled = 0;
    one.bot.on('message', () => void handled++);
    two.bot.on('message', () => void handled++);
    await one.message('a');
    await one.message('b'); // limited on bot 1
    await two.message('c'); // bot 2 is unaffected
    expect(handled).toBe(2);
    expect(await app.isLimited(7, 1)).toBe(true);
    expect(await app.isLimited(7, 2)).toBe(false);
    expect(await app.isLimited(7)).toBe(true); // on any bot

    await app.releaseUser(7);
    await app.limitUser(8, 60_000); // no bot id: every bot
    await one.message('x', { userId: 8 });
    await two.message('y', { userId: 8 });
    expect(handled).toBe(2);
  });
});

// Button params: parsing, signed buttons, allowedUsers, link buttons.
import { describe, expect, test } from 'bun:test';
import { EasyTG, InvalidParamsError, MemoryStorage, page, type EasyTGOptions, type StorageAdapter } from '../src';
import { createTestBot, type TestBotOptions } from '../src/testing';

function setup(options: EasyTGOptions = {}, bot: TestBotOptions = {}) {
  const t = createTestBot(bot);
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const errors: unknown[] = [];
  app.on('error', ({ error }) => void errors.push(error));
  return { ...t, app, errors };
}

const buttons = (payload: any): string[] => payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

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

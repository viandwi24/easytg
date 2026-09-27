import { describe, expect, test } from 'bun:test';
import { id as indonesianTexts } from '../examples/locales/id';
import { EasyTG, dialogue, page, type EasyTGOptions } from '../src';
import { splitText, visibleLength } from '../src/split';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options });
  t.bot.use(app);
  return { ...t, app };
}

describe('double taps', () => {
  test('an identical press right after the previous one is ignored', async () => {
    const { app, press, find, reset } = setup({ buttons: { doubleTapMs: 60 } });
    let renders = 0;
    app.register(page('p').render(() => ({ text: `render ${++renders}` })));

    await press('p|p');
    await press('p|p'); // accidental double tap
    expect(renders).toBe(1);
    expect(find('answerCallbackQuery')).toHaveLength(2); // both spinners stopped

    await press('p|p', { messageId: 999 }); // same data, other message: not a double tap
    expect(renders).toBe(2);

    reset();
    await Bun.sleep(70);
    await press('p|p');
    expect(renders).toBe(3);
  });

  test('presses while one is still running get a "please wait" toast', async () => {
    const { app, press, find } = setup();
    let renders = 0;
    app.register(
      page('slow').render(async () => {
        renders++;
        await Bun.sleep(30);
        return { text: 'done' };
      }),
      page('other').render(() => ((renders += 10), { text: 'other' })),
    );
    await Promise.all([press('p|slow'), press('p|other')]);
    expect(renders).toBe(1);
    expect(find('answerCallbackQuery').map((c) => c.payload.text)).toContain(app.texts.busy);
  });
});

describe('deep links', () => {
  function setupLinks(options: EasyTGOptions = {}) {
    const t = setup(options);
    const seen: unknown[] = [];
    const order = page<{ id: string; ref?: string }>('order')
      .allowDeepLink()
      .render(({ params }) => (seen.push(params), { text: `order ${params.id}` }));
    const promo = page('promo').allowDeepLink().render(() => ({ text: 'promo!' }));
    const secret = page('secret').render(() => ({ text: 'secret' }));
    const signup = dialogue<{ name: string }, { ref: string }>('signup')
      .allowDeepLink()
      .steps([{ id: 'name', type: 'text', text: 'Name?' }])
      .onFinish(({ answers, params }) => ({ text: `${answers.name} via ${params.ref}` }));
    const links = {} as Record<'order' | 'promo' | 'long' | 'signup', string>;
    const share = page('share').render(({ nav }) => {
      links.order = nav.deepLink(order, { id: '42' });
      links.promo = nav.deepLink(promo);
      links.long = nav.deepLink(order, { id: 'x'.repeat(80) });
      links.signup = nav.deepLink(signup, { ref: 'friend' });
      return { text: 'share' };
    });
    t.app.register(order, promo, secret, signup, share);
    let fallback = 0;
    t.bot.command('start', () => void fallback++);
    const payload = (url: string) => new URL(url).searchParams.get('start')!;
    return { ...t, seen, links, payload, order, secret, get fallback() { return fallback; } };
  }

  test('links open pages and start dialogues, for any user', async () => {
    const t = setupLinks();
    await t.press('p|share');
    expect(t.links.order).toMatch(/^https:\/\/t\.me\/test_bot\?start=_i[A-Za-z0-9_-]+$/);
    expect(t.links.promo).toBe('https://t.me/test_bot?start=promo');
    expect(t.payload(t.links.long)).toMatch(/^_s[A-Za-z0-9_-]{16}$/);

    await t.message(`/start ${t.payload(t.links.order)}`, { userId: 99 });
    expect(t.find('sendMessage').at(-1)!.payload).toMatchObject({ text: 'order 42' });
    expect(t.find('sendMessage').at(-1)!.payload.reply_parameters).toBeUndefined();

    await t.message(`/start ${t.payload(t.links.long)}`, { userId: 100 }); // stored, still shareable
    expect(t.seen.at(-1)).toEqual({ id: 'x'.repeat(80) });

    await t.message('/start promo');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('promo!');

    await t.message(`/start ${t.payload(t.links.signup)}`);
    await t.message('Ann');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Ann via friend');
    expect(t.fallback).toBe(0);
  });

  test('pages without allowDeepLink and unknown payloads fall through to /start', async () => {
    const t = setupLinks();
    await t.message('/start secret');
    await t.message('/start nothing-here');
    await t.message('/start');
    expect(t.fallback).toBe(3);
    expect(() => t.app.nav({ me: { username: 'b' } } as any).deepLink(t.secret)).toThrow(/allowDeepLink/);
  });

  test('stored mode rejects crafted inline params', async () => {
    const t = setupLinks({ buttons: { params: 'stored' } });
    await t.press('p|share');
    expect(t.payload(t.links.order)).toMatch(/^_s/);
    const forged = `_i${Buffer.from('order|id=1').toString('base64url')}`;
    await t.message(`/start ${forged}`);
    expect(t.seen).toHaveLength(0);
    expect(t.fallback).toBe(1);
    await t.message(`/start ${t.payload(t.links.order)}`);
    expect(t.seen).toEqual([{ id: '42' }]);
  });

  test('app.deepLink works outside a render', async () => {
    const t = setupLinks();
    const url = await t.app.deepLink(t.bot, t.order, { id: 'y'.repeat(70) });
    await t.message(`/start ${t.payload(url)}`);
    expect(t.seen).toEqual([{ id: 'y'.repeat(70) }]);
  });
});

describe('i18n', () => {
  test('built-in texts follow the user language, with region fallback', async () => {
    const { app, press, find } = setup({ i18n: { locales: { id: indonesianTexts } } });
    let locale: unknown;
    app.register(page('home').render((args) => ((locale = args.locale), { text: 'x', keyboard: [[args.nav.home(), args.nav.close()]] })));

    await press('p|home', { language: 'id-ID' });
    expect(locale).toBe('id-ID');
    expect(find('editMessageText')[0]!.payload.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['🏠 Beranda', '❌ Tutup']);

    await press('p|home', { language: 'fr', messageId: 2 });
    expect(find('editMessageText')[1]!.payload.reply_markup.inline_keyboard[0][0].text).toBe('🏠 Home');

    await press('p|nope', { language: 'id' });
    expect(find('answerCallbackQuery').at(-1)!.payload.text).toBe(indonesianTexts.pageNotFound);
  });

  test('a custom locale function can use the session', async () => {
    const { app, bot, message, find } = setup({
      i18n: {
        locales: { id: indonesianTexts },
        locale: (ctx, session) => session.get<string>('lang') ?? ctx.from?.language_code,
      },
    });
    const signup = dialogue('d').steps([{ id: 'a', type: 'text', text: 'A?' }]).onFinish(() => undefined);
    app.register(signup);
    bot.command('lang', async (ctx) => (await app.session(ctx)).set('lang', 'id'));
    bot.command('d', (ctx) => app.startDialogue(ctx, signup));

    await message('/lang', { language: 'en' });
    await message('/d', { language: 'en' });
    expect(find('sendMessage').at(-1)!.payload.reply_markup.inline_keyboard.at(-1)[0].text).toBe('❌ Batal');
  });
});

describe('long messages', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`);

  test('splitText respects visible length and keeps tags balanced', () => {
    const html = `<b>${'a'.repeat(3000)}\n${'b'.repeat(3000)}</b>`;
    const chunks = splitText(html, true, [4096]);
    expect(chunks).toEqual([`<b>${'a'.repeat(3000)}</b>`, `<b>${'b'.repeat(3000)}</b>`]);
    const entities = splitText('&amp;'.repeat(5000), true, [4096]);
    expect(entities.map((c) => visibleLength(c, true))).toEqual([4096, 904]);
  });

  test('long pages are sent as several messages, keyboard on the last', async () => {
    const { app, bot, message, find } = setup();
    const long = page('long').render(({ nav }) => ({ text: lines(150), keyboard: [[nav.close()]] }));
    app.register(long);
    bot.command('long', (ctx) => app.open(ctx, long));

    await message('/long');
    const sent = find('sendMessage').map((c) => c.payload) as [any, any];
    expect(sent.length).toBe(2);
    expect(sent.every((m) => visibleLength(m.text, true) <= 4096)).toBe(true);
    expect(sent[0].reply_markup).toBeUndefined();
    expect(sent[1].reply_markup.inline_keyboard).toHaveLength(1);
    expect(sent[0].reply_parameters).toBeDefined();
    expect(sent[1].reply_parameters).toBeUndefined();
  });

  test('editing replaces the whole group, and a short render removes the extra messages', async () => {
    const { app, press, find, sent, reset } = setup({ buttons: { doubleTapMs: 0 } });
    app.register(
      page('long').render(() => ({ text: lines(150) })),
      page('short').render(() => ({ text: 'short' })),
    );

    await press('p|long', { messageId: 500 });
    expect(find('deleteMessage')[0]!.payload.message_id).toBe(500); // replaced, not edited
    const [first, last] = sent.slice(-2).map((m) => m.message_id);

    reset();
    await press('p|short', { messageId: last });
    expect(find('editMessageText')[0]!.payload.text).toBe('short');
    expect(find('deleteMessage')[0]!.payload.message_id).toBe(first); // continuation removed

    // closing a long page removes all of its messages
    await press('p|long', { messageId: last });
    const group = sent.slice(-2).map((m) => m.message_id);
    reset();
    await press('p|exit', { messageId: group[1] });
    expect(find('deleteMessages')[0]!.payload.message_ids.sort()).toEqual(group.sort());
  });

  test('long captions continue in a text message', async () => {
    const { app, bot, message, find } = setup();
    const pic = page('pic').render(() => ({ photo: 'FILE', text: 'c'.repeat(1500) }));
    app.register(pic);
    bot.command('pic', (ctx) => app.open(ctx, pic));
    await message('/pic');
    expect(find('sendPhoto')[0]!.payload.caption.length).toBeLessThanOrEqual(1024);
    expect(find('sendMessage')).toHaveLength(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, md, page, replyMenu, type EasyTGOptions, type Logger } from '../src';
import { createTestBot } from '../src/testing';

const messages = {
  en: {
    hello: 'Hello {name}!',
    bold: 'Hi **{name}**',
    cart: { items: { one: '{count} item', other: '{count} items' }, empty: 'Your cart is empty' },
    menu: { orders: '🧾 Orders' },
    onlyEnglish: 'Only in English',
  },
  id: {
    hello: 'Halo {name}!',
    cart: { items: { other: '{count} barang' }, empty: 'Keranjang kosong' },
    menu: { orders: '🧾 Pesanan' },
  },
};

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, i18n: { messages }, buttons: { doubleTapMs: 0 }, ...options });
  t.bot.use(app);
  return { ...t, app };
}

describe('i18n messages', () => {
  test('placeholders, plurals, nesting and fallbacks', () => {
    const { app } = setup();
    const en = app.t('en');
    expect(en('hello', { name: 'Ann' })).toBe('Hello Ann!');
    expect(en('cart.items', { count: 1 })).toBe('1 item');
    expect(en('cart.items', { count: 3 })).toBe('3 items');
    expect(en('hello')).toBe('Hello {name}!'); // unknown vars stay visible

    const id = app.t('id-ID'); // region falls back to the language
    expect(id.locale).toBe('id');
    expect(id('hello', { name: 'Budi' })).toBe('Halo Budi!');
    expect(id('cart.items', { count: 1 })).toBe('1 barang');
    expect(id('onlyEnglish')).toBe('Only in English'); // missing key: fallback language
    expect(app.t('fr')('cart.empty')).toBe('Your cart is empty'); // unknown language: fallback
    expect(id.has('cart.empty')).toBe(true);
    expect(id.has('nope')).toBe(false);
  });

  test('missing keys return the key and warn once', () => {
    const warnings: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (m) => void warnings.push(String(m)), error() {} };
    const { app } = setup({ logger });
    expect(app.t('en')('nope.key')).toBe('nope.key');
    app.t('en')('nope.key');
    expect(warnings).toEqual(['Missing message "nope.key" (language: en)']);
  });

  test('t.md escapes vars, so user input cannot inject formatting', () => {
    const { app } = setup();
    const t = app.t('en');
    expect(t.md('bold', { name: '*evil* [x](http://e.vil)' }).html).toBe(md`Hi **${'*evil* [x](http://e.vil)'}**`.html);
    expect(t.html('hello', { name: '<b>' }).html).toBe('Hello &lt;b&gt;!');
  });

  test('t in renders, dialogues and menu labels follows the user language', async () => {
    const orders = page('orders').render(({ t }) => ({ text: t('cart.empty') }));
    const form = dialogue<{ n: string }>('form')
      .steps(({ t }) => [{ id: 'n', type: 'text', text: t('hello', { name: '?' }) }])
      .onFinish(({ t, answers }) => ({ text: t('cart.items', { count: Number(answers.n) }), parseMode: 'plain' }));
    const menu = replyMenu([[replyMenu.button((_, t) => t('menu.orders'), orders)]]);
    const { app, bot, message, find, reset } = setup({ menu });
    app.register(orders, form);
    bot.command('start', (ctx) => app.showMenu(ctx, 'menu'));
    bot.command('form', (ctx) => app.startDialogue(ctx, form));

    await message('/start', { language: 'id' });
    expect(find('sendMessage')[0]!.payload.reply_markup.keyboard[0][0].text).toBe('🧾 Pesanan');
    reset();
    await message('🧾 Pesanan', { language: 'id' });
    expect(find('sendMessage')[0]!.payload.text).toBe('Keranjang kosong');

    reset();
    await message('/form', { language: 'en' });
    expect(find('sendMessage')[0]!.payload.text).toBe('Hello ?!');
    await message('2', { language: 'en' });
    expect(find('sendMessage').at(-1)!.payload.text).toBe('2 items');
  });
});

describe('page.onText', () => {
  function searchApp(options: EasyTGOptions = {}) {
    const t = setup(options);
    const search = page<{ q?: string }>('search')
      .render(({ params }) => ({ text: params.q ? `Results for ${params.q}` : 'Type a product name', parseMode: 'plain' }))
      .onText(({ text, nav }) => nav.redirect(search, { q: text }));
    const other = page('other').render(() => ({ text: 'other' }));
    const ask = dialogue<{ a: string }>('ask')
      .steps([{ id: 'a', type: 'text', text: 'Question?' }])
      .onFinish(({ answers }) => ({ text: `answer ${answers.a}`, parseMode: 'plain' }));
    t.app.register(search, other, ask);
    const seen: string[] = [];
    t.bot.command('search', (ctx) => t.app.open(ctx, search));
    t.bot.command('other', (ctx) => t.app.open(ctx, other));
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));
    t.bot.on('message:text', (ctx) => void seen.push(ctx.message.text));
    return { ...t, search, seen };
  }

  test('text sent while the page is shown goes to onText', async () => {
    const { message, find, seen, reset } = searchApp();
    await message('hello'); // no search page yet: the app's own handler
    expect(seen).toEqual(['hello']);

    await message('/search');
    reset();
    await message('green tea');
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['Results for green tea']);
    await message('coffee'); // the results page is the search page too
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['Results for green tea', 'Results for coffee']);
    expect(seen).toEqual(['hello']);
  });

  test('commands still work, and another page ends the search', async () => {
    const { message, seen } = searchApp();
    await message('/search');
    await message('/other'); // a command: not a search, and shows a page without onText
    await message('tea');
    expect(seen).toEqual(['tea']);
  });

  test("a dialogue takes the user's text", async () => {
    const { message, find, reset } = searchApp();
    await message('/search');
    await message('/ask');
    reset();
    await message('42');
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['answer 42']);
    reset();
    await message('tea'); // the dialogue ended the search mode
    expect(find('sendMessage').length).toBe(0);
  });

  test("mode 'edit' updates the page message; deleteInput removes the user's text", async () => {
    const t = setup();
    const box = page<{ q?: string }>('box')
      .render(({ params }) => ({ text: `q=${params.q ?? ''}`, parseMode: 'plain' }))
      .onText(({ text, nav }) => nav.redirect(box, { q: text }), { mode: 'edit', deleteInput: true });
    t.app.register(box);
    t.bot.command('box', (ctx) => t.app.open(ctx, box));
    await t.message('/box');
    const pageMessage = t.sent.at(-1)!.message_id;
    t.reset();
    await t.message('abc');
    expect(t.methods()).toEqual(['editMessageText', 'deleteMessage']);
    expect(t.find('editMessageText')[0]!.payload).toMatchObject({ message_id: pageMessage, text: 'q=abc' });
  });

  test('in groups, only replies to the page message count', async () => {
    const { message, find, sent, seen, reset } = searchApp();
    await message('/search', { chatType: 'group' });
    const pageMessage = sent.at(-1)!.message_id;
    reset();
    await message('chatting', { chatType: 'group' });
    expect(find('sendMessage').length).toBe(0);
    await message('tea', { chatType: 'group', extra: { reply_to_message: { message_id: pageMessage } } });
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['Results for tea']);
    expect(seen).toEqual(['chatting']);
  });
});

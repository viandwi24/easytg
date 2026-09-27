// One test per bug found in the pre-release review.
import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, html, md, page, type EasyTGOptions } from '../src';
import { markdownToHtml } from '../src/format';
import { splitText, visibleLength } from '../src/split';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const user = { id: 7, is_bot: false, first_name: 'U7' };

describe('anti-spam only counts and drops user interactions', () => {
  test('inline queries never count; payments always pass, even for limited users', async () => {
    const t = setup({ antiSpam: { limit: 3 } });
    let inline = 0;
    let checkouts = 0;
    t.bot.on('inline_query', () => void inline++);
    t.bot.on('pre_checkout_query', () => void checkouts++);
    for (let i = 0; i < 25; i++) await t.update({ inline_query: { id: `${i}`, from: user, query: 'a', offset: '' } });
    expect(inline).toBe(25);
    expect(t.app.isLimited(7)).toBe(false);

    t.app.limitUser(7, 60_000);
    await t.update({ pre_checkout_query: { id: 'q', from: user, currency: 'USD', total_amount: 100, invoice_payload: 'x' } } as any);
    expect(checkouts).toBe(1);
  });

  test('group chatter does not count; group commands do', async () => {
    const t = setup({ antiSpam: { limit: 2 } });
    for (let i = 0; i < 10; i++) await t.message('chatting', { chatType: 'group' });
    expect(t.app.isLimited(7)).toBe(false);
    for (let i = 0; i < 3; i++) await t.message('/cmd', { chatType: 'group' });
    expect(t.app.isLimited(7)).toBe(true);
  });

  test('a custom filter decides what counts', async () => {
    const t = setup({ antiSpam: { limit: 1, filter: (ctx) => !!ctx.inlineQuery } });
    await t.update({ inline_query: { id: '1', from: user, query: 'a', offset: '' } });
    await t.update({ inline_query: { id: '2', from: user, query: 'a', offset: '' } });
    expect(t.app.isLimited(7)).toBe(true);
  });
});

test('service messages pass through an active dialogue', async () => {
  const t = setup();
  const d = dialogue('d').steps([{ id: 'a', type: 'text', text: 'A?' }]).onFinish(() => undefined);
  t.app.register(d);
  let paid = 0;
  t.bot.on('message:successful_payment', () => void paid++);
  t.bot.command('d', (ctx) => t.app.startDialogue(ctx, d));
  await t.message('/d');
  t.reset();
  await t.message('', { extra: { text: undefined, successful_payment: { currency: 'USD', total_amount: 1, invoice_payload: 'x' } } });
  expect(paid).toBe(1);
  expect(t.find('sendMessage')).toHaveLength(0); // no "please send a text" hint
});

test('with ownerOnly off, stored buttons work for everyone', async () => {
  const t = setup({ buttons: { ownerOnly: false, params: 'stored' } });
  let seen: unknown;
  const p = page<{ n?: string }>('p').render(({ params, nav }) => ((seen = params), { text: 'p', keyboard: [[nav.self('x', { n: 1 })]] }));
  t.app.register(p);
  t.bot.command('p', (ctx) => t.app.open(ctx, p));
  await t.message('/p', { userId: 1, chatType: 'group' });
  const data = t.find('sendMessage')[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data;
  await t.press(data, { userId: 2, chatType: 'group', messageId: t.sent.at(-1)!.message_id });
  expect(seen).toEqual({ n: '1' });
});

test('a middleware starting a dialogue cannot loop forever', async () => {
  const login = dialogue('login').steps([{ id: 'u', type: 'text', text: 'User?' }]).onFinish(() => undefined);
  // Forgets to let the login dialogue itself through, so it would restart itself forever:
  const t = setup({ middlewares: [({ session, nav }, next) => (session.get('user') ? next() : nav.startDialogue(login))] });
  const errors: unknown[] = [];
  t.app.on('error', ({ error }) => void errors.push(error));
  t.app.register(login, page('home').render(() => ({ text: 'home' })));
  await t.press('p|home');
  expect(String(errors[0])).toContain('Too many redirects');
});

test('built-in dialogue texts are safe in markdownv2 mode', async () => {
  const t = setup({ parseMode: 'markdownv2' });
  const d = dialogue('d').steps([{ id: 'a', type: 'text', text: 'Age\\?', validate: (v) => /^\d+$/.test(v) }]).onFinish(() => undefined);
  t.app.register(d);
  t.bot.command('d', (ctx) => t.app.startDialogue(ctx, d));
  await t.message('/d');
  t.reset();
  await t.message('abc');
  const [error, prompt] = t.find('sendMessage').map((c) => c.payload);
  expect(error).toMatchObject({ text: t.app.texts.invalidInput });
  expect(error!.parse_mode).toBeUndefined(); // "." would be rejected by MarkdownV2
  expect(prompt).toMatchObject({ text: 'Age\\?', parse_mode: 'MarkdownV2' });
});

describe('inline-mode messages', () => {
  const inlinePress = (t: ReturnType<typeof setup>, data: string) =>
    t.update({ callback_query: { id: 'q', from: user, chat_instance: 'x', inline_message_id: 'IM', data } });

  test('close strips the keyboard; long pages are truncated instead of failing', async () => {
    const t = setup();
    t.app.register(page('long').render(() => ({ text: Array.from({ length: 200 }, () => 'x'.repeat(40)) })));
    await inlinePress(t, 'p|exit');
    expect(t.methods()).toContain('editMessageReplyMarkup');
    t.reset();
    await inlinePress(t, 'p|long');
    const edit = t.find('editMessageText')[0]!.payload;
    expect(edit.inline_message_id).toBe('IM');
    expect(visibleLength(edit.text, true)).toBeLessThanOrEqual(4096);
    expect(t.find('sendMessage')).toHaveLength(0);
  });

  test('dialogues report a clear error instead of an API failure', async () => {
    const t = setup();
    const errors: unknown[] = [];
    t.app.on('error', ({ error }) => void errors.push(error));
    t.app.register(dialogue('d').steps([{ id: 'a', type: 'text', text: 'A?' }]).onFinish(() => undefined));
    await inlinePress(t, 'p|d');
    expect(String(errors[0])).toContain("can't start without a chat");
  });
});

test('md values inside code show exactly as typed; html escapes quotes', () => {
  expect(md`id: \`${'a.b_c'}\``.html).toBe('id: <code>a.b_c</code>');
  expect(md`\`${'x`y'}\` after`.html).toBe('<code>x`y</code> after');
  expect(md`${'x'}`.html).toBe('x');
  expect(markdownToHtml('```\na\\_b\n```')).toBe('<pre>a_b</pre>');
  expect(html`<a href='${"x' onclick='y"}'>t</a>`.html).toBe("<a href='x&#39; onclick=&#39;y'>t</a>");
});

test('splitText honours shrinking limits and counts emoji entities as 2', () => {
  const chunks = splitText('aaaaaaaaaaaaaa bbb\ncccccccccccccc', true, [20, 11]);
  expect(chunks.map((c) => visibleLength(c, true))).toEqual([18, 11, 3]);
  expect(visibleLength('&#128512;&#x1F600;&amp;', true)).toBe(5);
});

describe('commands for other bots are ignored', () => {
  test('/start@other_bot payload is not ours', async () => {
    const t = setup();
    let opened = 0;
    t.app.register(page('promo').allowDeepLink().render(() => ((opened++), { text: 'promo' })));
    await t.message('/start@other_bot promo');
    await t.message('/start@TEST_BOT promo'); // ours, case-insensitive
    expect(opened).toBe(1);
  });

  test('/cmd@other_bot does not cancel a dialogue', async () => {
    const t = setup();
    const d = dialogue('d').steps([{ id: 'a', type: 'text', text: 'A?' }]).onFinish(({ answers }) => ({ text: `got ${answers.a}` }));
    t.app.register(d);
    t.bot.command('d', (ctx) => t.app.startDialogue(ctx, d));
    await t.message('/d');
    await t.message('/help@other_bot'); // someone else's command: treated as input
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('got /help@other_bot');
  });
});

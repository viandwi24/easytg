// transformText, the markdownv1 parse mode and `entities` in page content.
import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, md, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

describe('transformText', () => {
  test('rewrites page text, captions, dialogue prompts and validation messages', async () => {
    const seen: string[] = [];
    const t = setup({
      parseMode: 'markdownv2',
      transformText: (text, { parseMode }) => {
        seen.push(parseMode);
        return `[${text}]`;
      },
    });
    const home = page('home').render(() => ({ text: 'home' }));
    const pic = page('pic').render(() => ({ photo: 'file-1', text: 'caption' }));
    const ask = dialogue('ask')
      .steps([{ id: 'name', type: 'text', text: 'Your name?', validate: (v) => (v.length < 2 ? 'Too short' : true) }])
      .onFinish(() => ({ text: 'done' }));
    t.app.register(home, pic, ask);
    t.bot.command('home', (ctx) => t.app.open(ctx, home));
    t.bot.command('pic', (ctx) => t.app.open(ctx, pic));
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));

    await t.message('/home');
    await t.message('/pic');
    await t.message('/ask');
    await t.message('x');
    const texts = t.find('sendMessage').map((c) => c.payload.text);
    expect(texts).toEqual(['[home]', '[Your name?]', '[Too short]', '[Your name?]']);
    expect(t.find('sendPhoto')[0]!.payload.caption).toBe('[caption]');
    expect(new Set(seen)).toEqual(new Set(['markdownv2']));
  });

  test("isn't called for md`` fragments, plain text or built-in messages", async () => {
    const t = setup({ transformText: (text) => `!${text}` });
    const home = page('home').render(() => ({ text: ['plain part', md`**safe**`] }));
    const raw = page('raw').render(() => ({ text: 'as is', parseMode: 'plain' }));
    const ask = dialogue('ask')
      .steps([{ id: 'n', type: 'number', text: 'How many?' }])
      .onFinish(() => ({ text: 'ok' }));
    t.app.register(home, raw, ask);
    t.bot.command('home', (ctx) => t.app.open(ctx, home));
    t.bot.command('raw', (ctx) => t.app.open(ctx, raw));
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));

    await t.message('/home');
    await t.message('/raw');
    await t.message('/ask');
    await t.message('many');
    const texts = t.find('sendMessage').map((c) => c.payload.text);
    expect(texts[0]).toBe('!plain part\n<b>safe</b>');
    expect(texts[1]).toBe('as is');
    expect(texts[3]).toBe(t.app.texts.expectNumber({})); // built-in, untouched
  });
});

describe('markdownv1', () => {
  test("sends parse_mode 'Markdown'", async () => {
    const t = setup({ parseMode: 'markdownv1' });
    const home = page('home').render(() => ({ text: '*bold* _italic_' }));
    t.app.register(home);
    t.bot.command('home', (ctx) => t.app.open(ctx, home));
    await t.message('/home');
    expect(t.find('sendMessage')[0]!.payload).toMatchObject({ text: '*bold* _italic_', parse_mode: 'Markdown' });
  });
});

describe('entities in page content', () => {
  const bold = [{ type: 'bold' as const, offset: 0, length: 1 }];

  test('text with entities goes out with them and without parse_mode, on send and edit', async () => {
    const t = setup();
    const home = page('home').render(({ nav }) => ({ text: 'a *b*', entities: bold, keyboard: [[nav.button('Again', 'home')]] }));
    t.app.register(home);
    t.bot.command('home', (ctx) => t.app.open(ctx, home));

    await t.message('/home');
    const sent = t.find('sendMessage')[0]!.payload;
    expect(sent.text).toBe('a *b*');
    expect(sent.entities).toEqual(bold);
    expect(sent.parse_mode).toBeUndefined();

    await t.press('p|home');
    const edited = t.find('editMessageText')[0]!.payload;
    expect(edited.entities).toEqual(bold);
    expect(edited.parse_mode).toBeUndefined();
  });

  test('under media they are caption entities', async () => {
    const t = setup();
    const pic = page('pic').render(() => ({ photo: 'file-1', text: 'a b', entities: bold }));
    t.app.register(pic);
    t.bot.command('pic', (ctx) => t.app.open(ctx, pic));
    await t.message('/pic');
    const payload = t.find('sendPhoto')[0]!.payload;
    expect(payload.caption_entities).toEqual(bold);
    expect(payload.parse_mode).toBeUndefined();
  });

  test('text that would have to be split, or md`` text, is refused', async () => {
    const t = setup();
    const errors: unknown[] = [];
    t.app.on('error', ({ error }) => void errors.push(error));
    const long = page('long').render(() => ({ text: 'x'.repeat(5000), entities: bold }));
    const mixed = page('mixed').render(() => ({ text: md`**x**`, entities: bold }));
    t.app.register(long, mixed);
    await t.press('p|long');
    await t.press('p|mixed');
    expect(String(errors[0])).toContain('fit one message');
    expect(String(errors[1])).toContain("can't be combined");
  });
});

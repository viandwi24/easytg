import { describe, expect, test } from 'bun:test';
import { EasyTG, html, md, page, type EasyTGOptions } from '../src';
import { TelegramSimulator, messageText, richButtons } from '../src/simulator';

function setup(options: EasyTGOptions = {}) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  bot.use(app);
  return { sim, bot, app };
}

const calls = (sim: TelegramSimulator, method: string) => sim.calls.filter((c) => c.method === method);

describe('rich pages', () => {
  test('a string is Rich Markdown, sent with sendRichMessage, with its keyboard', async () => {
    const { sim, app } = setup();
    const other = page('other').render(() => ({ text: 'Other' }));
    app.register(other).command(
      'start',
      page('report').render(({ nav }) => ({
        rich: ['# Weekly report', '', '| Metric | Value |', '|---|--:|', '| Speed | **42** ms |', '', '- one', '- two'],
        keyboard: [[nav.button('Other', other)]],
      })),
    );
    await sim.send('/start');
    expect(calls(sim, 'sendRichMessage')[0]!.payload.rich_message).toEqual({ markdown: '# Weekly report\n\n| Metric | Value |\n|---|--:|\n| Speed | **42** ms |\n\n- one\n- two' });
    const message = sim.last()!.message;
    expect(message.rich_message!.blocks.map((b) => b.type)).toEqual(['heading', 'table', 'list']);
    expect(messageText(message)).toBe('Weekly report\nMetric | Value\nSpeed | 42 ms\n• one\n• two');
    expect(message.reply_markup?.inline_keyboard[0]![0]!.text).toBe('Other');
  });

  test('md`` values are escaped for Rich Markdown: nothing a user typed becomes formatting', async () => {
    const { sim, app } = setup();
    const name = '# *Bob* | [x](https://evil.example) $a$ <b>hi</b> - ==m== ||s|| ~~d~~ `c` \\ 1.';
    app.command('start', page('hi').render(() => ({ rich: [md`## Hello ${name}`, md`Your code: \`${'a`b'}\``] })));
    await sim.send('/start');
    const message = sim.last()!.message;
    expect(message.rich_message!.blocks[0]).toEqual({ type: 'heading', size: 2, text: `Hello ${name}` });
    // In code nothing can be escaped: a backtick becomes a look-alike instead of ending it.
    expect(messageText(message)).toBe(`Hello ${name}\nYour code: aˋb`);
  });

  test('text ⇄ rich edit in place; media ⇄ rich replace the message', async () => {
    const { sim, app } = setup();
    const plain = page('plain').render(({ nav }) => ({ text: 'Plain', keyboard: [[nav.button('Rich', rich)], [nav.button('Photo', photo)]] }));
    const rich = page('rich').render(({ nav }) => ({ rich: '**Rich**', keyboard: [[nav.button('Plain', plain)], [nav.button('Photo', photo)]] }));
    const photo = page('photo').render(({ nav }) => ({ photo: 'https://example.com/p.jpg', text: 'A photo', keyboard: [[nav.button('Rich', rich)]] }));
    app.register(rich, photo).command('start', plain);
    await sim.send('/start');
    const id = sim.last()!.message.message_id;

    await sim.tap('Rich');
    expect(sim.last()!.message).toMatchObject({ message_id: id, rich_message: { blocks: [{ type: 'paragraph', text: { type: 'bold', text: 'Rich' } }] } });
    expect(sim.last()!.message.text).toBeUndefined();
    await sim.tap('Plain');
    expect(sim.last()!.message).toMatchObject({ message_id: id, text: 'Plain' });
    expect(sim.last()!.message.rich_message).toBeUndefined();

    await sim.tap('Photo');
    const photoId = sim.last()!.message.message_id;
    expect(photoId).toBe(id); // text → media edits in place (Bot API 10)
    await sim.tap('Rich'); // media → rich can't be edited: a new message replaces it
    expect(sim.messages(sim.user.id).filter((m) => m.fromBot)).toHaveLength(1);
    expect(sim.last()!.message.rich_message).toBeDefined();
    expect(sim.last()!.message.message_id).not.toBe(id);
    await sim.tap('Photo'); // rich → media: replaced too
    expect(sim.messages(sim.user.id).filter((m) => m.fromBot)).toHaveLength(1);
    expect(sim.last()!.message.photo).toBeDefined();
  });

  test('one html`` fragment is Rich HTML; other forms go as they are', async () => {
    const { sim, app } = setup();
    const who = '<script>&';
    app.command('a', page('a').render(() => ({ rich: html`<h1>Hi ${who}</h1><details open><summary>More</summary><p>Inside</p></details>` })));
    app.command('b', page('b').render(() => ({ rich: { blocks: [{ type: 'heading', size: 1, text: 'Blocks' }, { type: 'divider' }] } })));
    await sim.send('/a');
    expect(calls(sim, 'sendRichMessage')[0]!.payload.rich_message).toEqual({ html: '<h1>Hi &lt;script&gt;&amp;</h1><details open><summary>More</summary><p>Inside</p></details>' });
    expect(messageText(sim.last()!.message)).toBe('Hi <script>&\nMore\nInside');
    await sim.send('/b');
    expect(sim.last()!.message.rich_message!.blocks).toEqual([{ type: 'heading', size: 1, text: 'Blocks' }, { type: 'divider' }]);
  });

  test('clear errors for content that can not be a rich message', async () => {
    const { sim, app } = setup();
    const errors: string[] = [];
    app.on('error', ({ error }) => void errors.push((error as Error).message));
    app.command('a', page('a').render(() => ({ rich: '# x', text: 'y' })));
    app.command('b', page('b').render(() => ({ rich: '# x', photo: 'https://example.com/p.jpg' })));
    app.command('c', page('c').render(() => ({ rich: [html`<b>x</b>`, 'y'] })));
    app.command('d', page('d').render(() => ({ rich: { markdown: 'x', html: 'y' } })));
    for (const c of ['/a', '/b', '/c', '/d']) await sim.send(c);
    expect(errors).toEqual([
      "rich content can't be combined with text: a rich message carries its media in itself",
      "rich content can't be combined with photo: a rich message carries its media in itself",
      "rich: an html`` fragment can't be mixed with Markdown; use one html`` fragment, or md`` fragments and strings",
      'rich needs exactly one of markdown, html or blocks',
    ]);
  });

  test('buttons inside a rich message press like inline buttons (nav.data)', async () => {
    const { sim, app } = setup();
    const done = page('done').render(() => ({ text: 'Done!' }));
    app.register(done).command(
      'start',
      page('card').render(({ nav }) => ({
        rich: html`<p>Ready? <tg-button type="callback_data" data="${nav.data(done)}">Go</tg-button></p>`,
      })),
    );
    await sim.send('/start');
    const message = sim.last()!.message;
    expect(richButtons(message.rich_message).map((b) => b.text)).toEqual(['Go']);
    await sim.tap('Go');
    expect(sim.last()!.message).toMatchObject({ message_id: message.message_id, text: 'Done!' });
  });

  test('ephemeral rich pages in groups', async () => {
    const { sim, app } = setup({ buttons: { ownerOnly: false } });
    const bob = sim.addUser({ first_name: 'Bob' }).id;
    const group = sim.createGroup({ title: 'G', members: [sim.user.id, bob] });
    const mine = page('mine').render(({ ctx }) => ({ rich: md`### Only for ${ctx.from!.first_name}` }));
    app.register(mine).command('menu', page('menu').render(({ nav }) => ({ text: 'Menu', keyboard: [[nav.button('Mine', mine, {}, { mode: 'ephemeral' })]] })));
    await sim.send('/menu', { chat: group.id });
    await sim.tap('Mine', { chat: group.id, user: bob });
    expect(calls(sim, 'sendRichMessage')[0]!.payload.ephemeral_message_parameters).toMatchObject({ receiver_user_id: bob });
    expect(messageText(sim.last(group.id, bob)!.message)).toBe('Only for Bob');
    expect(sim.messages(group.id, sim.user.id).map((m) => messageText(m.message))).toEqual(['/menu', 'Menu']);
  });

  test('sendTo and inline results', async () => {
    const { sim, bot, app } = setup();
    const card = page('card').render(() => ({ rich: '**Card**' }));
    app.register(card);
    await sim.send('/start');
    await app.sendTo(bot, sim.user.id, card);
    expect(messageText(sim.last()!.message)).toBe('Card');

    bot.on('inline_query', async (ctx) => ctx.answerInlineQuery([await app.inlineResult(ctx, card, { title: 'Card' })]));
    const [result] = await sim.inlineQuery('x');
    expect((result as { input_message_content: unknown }).input_message_content).toEqual({ rich_message: { markdown: '**Card**' } });
    const chosen = await sim.chooseInlineResult(result!, 'x');
    expect(messageText(chosen.message)).toBe('Card');
  });
});

describe('app.stream with rich', () => {
  test('rich drafts while it grows, then a rich message', async () => {
    const { sim, bot, app } = setup();
    bot.command('ask', async (ctx) => {
      await app.stream(
        ctx,
        (async function* () {
          for (const part of ['## Answer\n\n', '| a | b |\n', '|---|---|\n', '| 1 | 2 |\n']) {
            await Bun.sleep(3);
            yield part;
          }
        })(),
        { rich: true, intervalMs: 0 },
      );
    });
    await sim.send('/ask');
    expect(calls(sim, 'sendMessageDraft')[0]!.payload.text).toBe(''); // "Thinking…"
    const drafts = calls(sim, 'sendRichMessageDraft');
    expect(drafts.at(-1)!.payload.rich_message).toEqual({ markdown: '## Answer\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' });
    const message = sim.last()!.message;
    expect(message.rich_message!.blocks.map((b) => b.type)).toEqual(['heading', 'table']);
    expect(sim.chat(sim.user.id)!.draft).toBeNull();
  });

  test('groups: the growing message becomes rich', async () => {
    const { sim, bot, app } = setup();
    const group = sim.createGroup({ title: 'G' });
    bot.command('ask', (ctx) => app.stream(ctx, ['**one** ', 'two'].values() as never, { rich: true, intervalMs: 0 }).then(() => undefined));
    await sim.send('/ask', { chat: group.id });
    const mine = sim.messages(group.id).filter((m) => m.fromBot);
    expect(mine).toHaveLength(1);
    expect(messageText(mine[0]!.message)).toBe('one two');
  });
});

describe('simulator: rich messages', () => {
  test('errors like Telegram: one of markdown/html/blocks, supported tags, http(s) media, media references', async () => {
    const { sim, bot } = setup();
    await sim.send('/start');
    const send = (rich: object) => bot.api.sendRichMessage(sim.user.id, rich as never);
    await expect(send({ markdown: 'a', html: 'b' })).rejects.toThrow('exactly one of');
    await expect(send({ html: '<span>x</span>' })).rejects.toThrow('unsupported tag <span>');
    await expect(send({ markdown: '![](ftp://e.com/a.png)' })).rejects.toThrow('only HTTP and HTTPS URLs');
    await expect(send({ markdown: '![](tg://photo?id=nope)' })).rejects.toThrow('"nope" not found');
    await expect(send({ markdown: '  ' })).rejects.toThrow('message text is empty');
    const ok = await send({ markdown: '![](tg://photo?id=p1 "Cover")', media: [{ id: 'p1', media: { type: 'photo', media: 'https://e.com/c.jpg' } }] });
    expect(ok.rich_message.blocks[0]).toMatchObject({ type: 'photo', caption: { text: 'Cover' } });
    expect(sim.fileUrl((ok.rich_message.blocks[0] as { photo: { file_id: string }[] }).photo[0]!.file_id)).toBe('https://e.com/c.jpg');
  });

  test('Markdown: lists, task lists, nested lists, quotes, code, formulas, details and footnotes', async () => {
    const { sim, bot } = setup();
    await sim.send('/start');
    const sent = await bot.api.sendRichMessage(sim.user.id, {
      markdown: [
        '1. first',
        '2. second',
        '   - nested',
        '',
        '- [ ] todo',
        '- [x] done',
        '',
        '> quoted',
        '',
        '```ts',
        'let a = 1;',
        '```',
        '',
        '$$E = mc^2$$',
        '',
        'See[^1] and $x^2$ and snake_case_name.',
        '',
        '[^1]: A note.',
        '',
        '<details><summary>More</summary>',
        '',
        '- hidden',
        '',
        '</details>',
      ].join('\n'),
    });
    expect(sent.rich_message.blocks.map((b) => b.type)).toEqual(['list', 'list', 'blockquote', 'pre', 'mathematical_expression', 'paragraph', 'paragraph', 'details']);
    expect(messageText(sent)).toBe(
      ['1. first', '2. second', '  • nested', '☐ todo', '☑ done', 'quoted', 'let a = 1;', 'E = mc^2', 'See[1] and x^2 and snake_case_name.', '1. A note.', 'More', '• hidden'].join('\n'),
    );
    expect(sent.rich_message.blocks[3]).toEqual({ type: 'pre', text: 'let a = 1;', language: 'ts' });
  });

  test('a media message has no text to edit into a rich one', async () => {
    const { sim, bot } = setup();
    await sim.send('/start');
    const photo = await bot.api.sendPhoto(sim.user.id, 'https://e.com/p.jpg');
    await expect(bot.api.editMessageText(sim.user.id, photo.message_id, { markdown: 'x' })).rejects.toThrow('there is no text in the message to edit');
  });
});

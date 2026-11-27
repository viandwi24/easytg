// Dialogue step `expect`, onFinish `{ mode: 'reply' }` and what `collect` keeps (entities, albums, order).
import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, type Collected, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const sticker = { text: undefined, sticker: { file_id: 'S1', file_unique_id: 's1', type: 'regular', width: 512, height: 512, is_animated: false, is_video: false } };

describe('step expect', () => {
  test("the step's own message when the reply is the wrong kind, then the prompt again", async () => {
    const t = setup();
    const ask = dialogue('ask')
      .steps([
        { id: 'name', type: 'text', text: 'Your name?', expect: 'Please type your name.' },
        { id: 'age', type: 'number', text: 'Your age?', expect: ({ answers }) => `${answers.name}, send a number.` },
      ])
      .onFinish(() => ({ text: 'done' }));
    t.app.register(ask);
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));

    await t.message('/ask');
    t.reset();
    await t.message('', { extra: sticker });
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual(['Please type your name.', 'Your name?']);

    await t.message('Ann');
    t.reset();
    await t.message('old');
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual(['Ann, send a number.', 'Your age?']);
  });

  test('without it, the built-in message', async () => {
    const t = setup();
    const ask = dialogue('ask')
      .steps([{ id: 'name', type: 'text', text: 'Your name?' }])
      .onFinish(() => ({ text: 'done' }));
    t.app.register(ask);
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));
    await t.message('/ask');
    t.reset();
    await t.message('', { extra: sticker });
    expect(t.find('sendMessage')[0]!.payload.text).toBe(t.app.texts.expectText);
  });
});

describe("onFinish { mode: 'reply' }", () => {
  test("the result replies to the user's last answer", async () => {
    const t = setup();
    const ask = dialogue('ask')
      .steps([{ id: 'name', type: 'text', text: 'Your name?' }])
      .onFinish(({ answers }) => ({ text: `Hi ${answers.name}` }), { mode: 'reply' });
    t.app.register(ask);
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));
    await t.message('/ask');
    t.reset();
    await t.message('Ann', { extra: { message_id: 321 } });
    const finished = t.find('sendMessage').find((c) => c.payload.text === 'Hi Ann')!;
    expect(finished.payload.reply_parameters).toMatchObject({ message_id: 321 });
  });

  test('by default it is a new message', async () => {
    const t = setup();
    const ask = dialogue('ask')
      .steps([{ id: 'name', type: 'text', text: 'Your name?' }])
      .onFinish(({ answers }) => ({ text: `Hi ${answers.name}` }));
    t.app.register(ask);
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));
    await t.message('/ask');
    await t.message('Ann');
    expect(t.find('sendMessage').find((c) => c.payload.text === 'Hi Ann')!.payload.reply_parameters).toBeUndefined();
  });
});

describe('collect', () => {
  test('keeps formatting, album ids and the order things were sent in', async () => {
    const t = setup();
    let got: Collected | undefined;
    const post = dialogue('post')
      .steps([{ id: 'content', type: 'collect', text: 'Send the post' }])
      .onFinish(({ answers }) => ((got = answers.content), { text: 'ok' }));
    t.app.register(post);
    t.bot.command('post', (ctx) => t.app.startDialogue(ctx, post));

    const bold = [{ type: 'bold', offset: 0, length: 5 }];
    const photo = (id: string, extra: object = {}) => ({ text: undefined, photo: [{ file_id: id, file_unique_id: id, width: 1, height: 1 }], media_group_id: 'G1', ...extra });
    await t.message('/post');
    await t.message('Hello world', { extra: { entities: bold } });
    await t.message('', { extra: photo('P1', { caption: 'Promo here', caption_entities: bold }) });
    await t.message('', { extra: photo('P2') });
    await t.press(t.find('sendMessage').at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data);

    expect(got!.texts).toEqual(['Hello world']);
    expect(got!.items).toEqual([
      { kind: 'text', text: 'Hello world', entities: bold },
      expect.objectContaining({ kind: 'photo', fileId: 'P1', caption: 'Promo here', captionEntities: bold, mediaGroupId: 'G1' }),
      expect.objectContaining({ kind: 'photo', fileId: 'P2', mediaGroupId: 'G1' }),
    ] as never);
    expect(got!.files[1]!.captionEntities).toBeUndefined();
  });
});

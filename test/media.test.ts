import { describe, expect, test } from 'bun:test';
import { EasyTG, EasyTGError, page, type PageContent } from '../src';
import { createTestBot } from '../src/testing';

function setup(content: Record<string, PageContent>) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 } });
  t.bot.use(app);
  const errors: unknown[] = [];
  app.on('error', ({ error }) => void errors.push(error));
  for (const [id, c] of Object.entries(content)) app.register(page(id).render(({ nav }) => ({ ...c, keyboard: c.keyboard ?? [[nav.close()]] })));
  t.bot.command('open', (ctx) => app.open(ctx, ctx.match));
  return { ...t, app, errors };
}

describe('single media', () => {
  test.each([
    ['photo', 'sendPhoto'],
    ['video', 'sendVideo'],
    ['animation', 'sendAnimation'],
    ['document', 'sendDocument'],
    ['audio', 'sendAudio'],
  ] as const)('%s is sent with the text as caption', async (type, method) => {
    const t = setup({ p: { [type]: 'FILE_ID', text: '**caption**' } });
    await t.message('/open p');
    const [call] = t.find(method);
    expect(call!.payload).toMatchObject({ [type]: 'FILE_ID', caption: '<b>caption</b>', parse_mode: 'HTML' });
    expect(call!.payload.reply_markup.inline_keyboard).toHaveLength(1);
  });

  test('switching media edits it in place; the same file only edits the caption', async () => {
    const t = setup({ vid: { video: 'VID', text: 'a video' }, doc: { document: 'DOC', text: 'a document' } });
    await t.press('p|vid', { message: { text: undefined, photo: [{ file_id: 'PHOTO' }] } });
    expect(t.find('editMessageMedia')[0]!.payload.media).toMatchObject({ type: 'video', media: 'VID', caption: 'a video' });

    t.reset();
    await t.press('p|doc', { message: { text: undefined, document: { file_id: 'DOC' } } });
    expect(t.methods()).toContain('editMessageCaption');
    expect(t.methods()).not.toContain('editMessageMedia');
  });

  test('only one media per content', async () => {
    const t = setup({ bad: { photo: 'A', video: 'B', text: 'x' } });
    await t.press('p|bad');
    expect(t.errors[0]).toBeInstanceOf(EasyTGError);
    expect(String(t.errors[0])).toContain('only one of');
  });
});

describe('albums', () => {
  const album = [
    { type: 'photo' as const, media: 'P1' },
    { type: 'photo' as const, media: 'P2' },
    { type: 'video' as const, media: 'V1' },
  ];

  test('without a keyboard the text is the caption of the first item', async () => {
    const t = setup({ gallery: { album, text: 'Our **shop**', keyboard: [] } });
    await t.message('/open gallery');
    const media = t.find('sendMediaGroup')[0]!.payload.media;
    expect(media[0]).toMatchObject({ type: 'photo', media: 'P1', caption: 'Our <b>shop</b>', parse_mode: 'HTML' });
    expect(media[1].caption).toBeUndefined();
    expect(t.find('sendMessage')).toHaveLength(0);
  });

  test('with a keyboard, text and buttons follow in their own message', async () => {
    const t = setup({ gallery: { album, text: 'Pick one' } });
    await t.message('/open gallery');
    expect(t.find('sendMediaGroup')[0]!.payload.media[0].caption).toBeUndefined();
    const [text] = t.find('sendMessage');
    expect(text!.payload).toMatchObject({ text: 'Pick one' });
    expect(text!.payload.reply_markup.inline_keyboard).toHaveLength(1);
  });

  test('navigating away from an album edits its text message and deletes the album', async () => {
    const t = setup({ gallery: { album, text: 'Pick one' }, other: { text: 'other page' } });
    await t.message('/open gallery');
    const ids = t.sent.map((m) => m.message_id); // 3 album items + the text message
    expect(ids).toHaveLength(4);
    t.reset();
    await t.press('p|other', { messageId: ids.at(-1) });
    expect(t.find('editMessageText')[0]!.payload.text).toBe('other page');
    expect(t.find('deleteMessages')[0]!.payload.message_ids).toEqual(ids.slice(0, 3));
  });

  test('album size and keyboard rules', async () => {
    const t = setup({
      one: { album: album.slice(0, 1), text: 'x' },
      nokb: { album, keyboard: [[{ text: 'x', callback_data: 'x' }]] },
    });
    await t.press('p|one');
    await t.press('p|nokb', { messageId: 2 });
    expect(t.errors.map(String)).toEqual([
      expect.stringContaining('2 to 10 items'),
      expect.stringContaining('needs text'),
    ]);
  });
});

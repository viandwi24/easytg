// Delivery: long and split pages, the file id cache, app.answer.
import { describe, expect, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions } from '../src';
import { markdownToHtml } from '../src/format';
import { splitText } from '../src/split';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const buttons = () => t.calls.filter((c) => c.payload.reply_markup?.inline_keyboard).at(-1)!.payload.reply_markup.inline_keyboard.flat();
  const button = (label: string) => buttons().find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, buttons, button };
}

describe('delivery', () => {
  test("app.edit never deletes the message when the page doesn't fit in it", async () => {
    const { app, bot, methods } = setup();
    app.register(
      page('long').render(() => ({ text: 'word '.repeat(1000), parseMode: 'plain' })),
      page('album').render(() => ({ album: [{ type: 'photo', media: 'A' }, { type: 'photo', media: 'B' }] })),
    );
    expect(await app.edit(bot, { chatId: 7, messageId: 55 }, 'long')).toBeUndefined();
    expect(await app.edit(bot, { chatId: 7, messageId: 56 }, 'album')).toBeUndefined();
    expect(methods()).toEqual([]);
  });

  test('a keyboard-only page keeps the earlier parts of a long message', async () => {
    const { app, bot, message, press, button, sent, methods, reset } = setup();
    const kbOnly = page('kb').render(({ nav }) => ({ keyboard: [[nav.button('again', 'kb')]] }));
    const long = page('long').render(({ nav }) => ({ text: 'word '.repeat(1000), parseMode: 'plain', keyboard: [[nav.button('toggle', kbOnly)]] }));
    app.register(long, kbOnly);
    bot.command('go', (ctx) => app.open(ctx, long));
    await message('/go');
    const data = button('toggle');
    reset();
    await press(data, { messageId: sent.at(-1)!.message_id });
    expect(methods()).toEqual(['editMessageReplyMarkup', 'answerCallbackQuery']);
  });

  test('MarkdownV2 is never cut between a backslash and what it escapes; blank chunks are dropped', () => {
    for (const chunk of splitText('xx' + 'a\\.'.repeat(2000), false, [4096], true)) {
      expect(chunk.match(/\\*$/)![0].length % 2).toBe(0);
    }
    expect(splitText('aaaa' + ' '.repeat(40) + 'bbbb', false, [10])).toEqual(['aaaa      ', 'bbbb']);
  });

  test('code keeps its backslashes; fences accept languages like c++', () => {
    expect(markdownToHtml('`\\d+\\.x`')).toBe('<code>\\d+\\.x</code>');
    expect(markdownToHtml('```c#\n**x**\n```')).toBe('<pre><code class="language-c#">**x**</code></pre>');
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

describe('app.answer', () => {
  test('answers the press early, once', async () => {
    const { app, press, find } = setup();
    app.register(
      page('slow').render(async ({ ctx }) => {
        await app.answer(ctx, 'Working…');
        return { text: 'done', toast: 'ignored' };
      }),
    );
    await press('p|slow');
    expect(find('answerCallbackQuery').map((c) => c.payload.text)).toEqual(['Working…']);
  });
});

// Delivery modes: the pressed message, copy and protectContent, the `sent` event.
import { describe, expect, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions } from '../src';
import { createTestBot, type TestBotOptions } from '../src/testing';

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
    // The new message first, then the old one loses its buttons (a failed send leaves it usable).
    expect(t.methods()).toEqual(['sendMessage', 'editMessageReplyMarkup', 'answerCallbackQuery']);
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

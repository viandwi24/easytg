// Sending without an update: app.edit, prepareProactive, proactive errors.
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, page, type EasyTGOptions } from '../src';
import { createTestBot, telegramError, type TestBotOptions } from '../src/testing';

function setup(options: EasyTGOptions = {}, bot: TestBotOptions = {}) {
  const t = createTestBot(bot);
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const errors: unknown[] = [];
  app.on('error', ({ error }) => void errors.push(error));
  return { ...t, app, errors };
}

const buttons = (payload: any): string[] => payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

describe('5. app.edit', () => {
  test('re-renders a page into an existing message', async () => {
    const t = setup();
    const card = page<{ status: string }>('card').render(({ params, nav }) => ({
      text: `Status: ${params.status}`,
      keyboard: [[nav.self('Refresh', { status: params.status })]],
    }));
    t.app.register(card);
    await t.app.edit(t.bot, { chatId: -100, messageId: 55 }, card, { status: 'approved' });
    expect(t.find('editMessageText')[0]!.payload).toMatchObject({ chat_id: -100, message_id: 55, text: 'Status: approved' });
  });

  test('media messages get their caption edited; missing messages are not re-sent', async () => {
    const t = setup();
    t.app.register(page('card').render(() => ({ text: 'updated' })));
    t.responders.editMessageText = () => telegramError('Bad Request: there is no text in the message to edit');
    await t.app.edit(t.bot, { chatId: 5, messageId: 9 }, 'card');
    expect(t.find('editMessageCaption')[0]!.payload).toMatchObject({ message_id: 9, caption: 'updated' });

    t.responders.editMessageText = () => telegramError('Bad Request: message to edit not found');
    const result = await t.app.edit(t.bot, { chatId: 5, messageId: 10 }, 'card');
    expect(result).toBeUndefined();
    expect(t.find('sendMessage')).toHaveLength(0);
  });
});

describe('7. prepareProactive', () => {
  test('adds what middlewares normally put on ctx, for sendTo and broadcast', async () => {
    type Ctx = import('grammy').Context & { user?: { name: string } };
    const users: Record<number, string> = { 1: 'Ann', 2: 'Bob' };
    const t = createTestBot<Ctx>();
    const app = new EasyTG<Ctx>({
      logger: false,
      prepareProactive: async (ctx) => void (ctx.user = { name: users[ctx.from!.id]! }),
    });
    const hello = page<{}, Ctx>('hello').render(({ ctx }) => ({ text: `Hi ${ctx.user?.name}` }));
    app.register(hello);
    await app.sendTo(t.bot, 1, hello);
    await app.broadcast(t.bot, [2], hello, { perSecond: 1000 });
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual(['Hi Ann', 'Hi Bob']);
  });
});

describe('0.2.1', () => {
  test('sendTo / edit errors reach the error event with emitProactiveErrors (and are still thrown)', async () => {
    const t = setup({ emitProactiveErrors: true });
    const events: string[] = [];
    t.app.on('error', ({ source }) => void events.push(source));
    t.app.register(page('p').render(() => ({ text: 'x' })));
    t.responders.sendMessage = () => telegramError('Forbidden: bot was blocked by the user', { code: 403 });
    await expect(t.app.sendTo(t.bot, 5, 'p')).rejects.toThrow();
    t.responders.editMessageText = () => telegramError('Bad Request: something odd');
    await expect(t.app.edit(t.bot, { chatId: 5, messageId: 1 }, 'p')).rejects.toThrow();
    // broadcast failures are reported in its result, not as error events
    const news = page('news').render(() => ({ text: 'news' }));
    t.app.register(news);
    const result = await t.app.broadcast(t.bot, [5, 6], news, { perSecond: 1000 });
    expect(result.blocked).toBe(2);
    expect(events).toEqual(['sendTo', 'edit']);
  });

  test('no "no user" warning for sendTo to a group without a user', async () => {
    const warnings: string[] = [];
    const t = createTestBot();
    const app = new EasyTG({ logger: { debug() {}, info() {}, warn: (m) => void warnings.push(m), error() {} } });
    app.register(page('g').render(() => ({ text: 'hello group' })));
    await app.sendTo(t.bot, -100, 'g');
    expect(t.find('sendMessage')).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test('busy, double-tap and anti-spam state is per bot', async () => {
    const storage = new MemoryStorage();
    const make = (id: number) => {
      const t = setup({ storage, antiSpam: { limit: 2 }, buttons: { doubleTapMs: 1000 } }, { botInfo: { id } });
      let renders = 0;
      t.app.register(page('p').render(() => ((renders++), { text: 'p' })));
      return { ...t, renders: () => renders };
    };
    const [a, b] = [make(1), make(2)];
    // the same button data and message id on two bots is not a double tap
    await a.press('p|p', { messageId: 5 });
    await b.press('p|p', { messageId: 5 });
    expect([a.renders(), b.renders()]).toEqual([1, 1]);

    // one app instance serving two bots: limits are counted per bot
    const app = new EasyTG({ logger: false, antiSpam: { limit: 1 } });
    const one = createTestBot({ botInfo: { id: 1 } });
    const two = createTestBot({ botInfo: { id: 2 } });
    one.bot.use(app);
    two.bot.use(app);
    let handled = 0;
    one.bot.on('message', () => void handled++);
    two.bot.on('message', () => void handled++);
    await one.message('a');
    await one.message('b'); // limited on bot 1
    await two.message('c'); // bot 2 is unaffected
    expect(handled).toBe(2);
    expect(await app.isLimited(7, 1)).toBe(true);
    expect(await app.isLimited(7, 2)).toBe(false);
    expect(await app.isLimited(7)).toBe(true); // on any bot

    await app.releaseUser(7);
    await app.limitUser(8, 60_000); // no bot id: every bot
    await one.message('x', { userId: 8 });
    await two.message('y', { userId: 8 });
    expect(handled).toBe(2);
  });
});

/**
 * How to test an easytg bot: `easytg/testing` runs it against a fake Telegram
 * API, with no token and no network. Run with `bun test`.
 *
 * In your project, import from 'easytg' and 'easytg/testing' instead.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, dialogue, page, replyMenu, task, type DialogueContact } from '../src';
import { createTestBot, telegramError } from '../src/testing';

// ---- the bot under test -------------------------------------------------------

function createApp() {
  const home = page('home').render(({ nav }) => ({
    text: 'Welcome!',
    keyboard: [[nav.button('📦 Orders', orders)], [nav.button('📝 Register', register)]],
  }));
  const orders = page('orders').render(({ session, nav }) => ({
    text: `You have ${session.get<number>('orders') ?? 0} order(s).`,
    keyboard: [[nav.back()]],
  }));
  const register = dialogue<{ name: string; phone: DialogueContact }>('register')
    .steps([
      { id: 'name', type: 'text', text: 'Your name?', validate: (v) => v.length >= 2 || 'Too short' },
      { id: 'phone', type: 'contact', text: 'Your phone number?' },
    ])
    .onFinish(({ answers, session }) => {
      session.set('phone', answers.phone.phoneNumber);
      return { text: `Thanks ${answers.name}!` };
    });

  const app = new EasyTG({ logger: false, menu: replyMenu([[replyMenu.button('🏠 Home', home)]]) });
  app.register(home, orders, register);
  return { app, home, orders };
}

function setup() {
  const t = createTestBot();
  const { app, home, orders } = createApp();
  t.bot.use(app);
  t.bot.command('start', (ctx) => app.open(ctx, home));

  // Helpers worth keeping in your own tests:
  /** Text and inline buttons of the last message sent or edited. */
  const screen = () => {
    const call = t.calls.filter((c) => /^(send|edit)Message/.test(c.method)).at(-1)!;
    const buttons = (call.payload.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data: string }[];
    return { text: call.payload.text as string, buttons };
  };
  /** Press the inline button whose label contains `label`. */
  const tap = (label: string) => {
    const button = screen().buttons.find((b) => b.text.includes(label));
    if (!button) throw new Error(`No "${label}" button; have: ${screen().buttons.map((b) => b.text).join(', ')}`);
    return t.press(button.callback_data, { messageId: t.sent.at(-1)!.message_id });
  };

  return { ...t, app, orders, screen, tap };
}

// ---- tests ----------------------------------------------------------------------

describe('navigation', () => {
  test('/start shows the menu, buttons navigate, Back returns', async () => {
    const t = setup();
    await t.message('/start');
    expect(t.screen().text).toBe('Welcome!');

    await t.tap('Orders');
    expect(t.screen().text).toBe('You have 0 order(s).');

    await t.tap('Back');
    expect(t.screen().text).toBe('Welcome!');
  });

  test('pages can be opened with any session state', async () => {
    const t = setup();
    t.bot.command('seed', async (ctx) => (await t.app.session(ctx)).set('orders', 3));
    await t.message('/seed');
    await t.message('/start');
    await t.tap('Orders');
    expect(t.screen().text).toBe('You have 3 order(s).');
  });
});

describe('dialogues', () => {
  test('validation, contact sharing and the result', async () => {
    const t = setup();
    await t.message('/start');
    await t.tap('Register');

    await t.message('A');
    expect(t.find('sendMessage').at(-2)!.payload.text).toBe('Too short');

    await t.message('Ann');
    // Share a contact, as the "📱 Share my contact" button would:
    await t.message('', { extra: { text: undefined, contact: { phone_number: '+62812', first_name: 'Ann', user_id: 7 } } });
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Thanks Ann!');
  });
});

describe('failures', () => {
  test('simulate Telegram errors with responders', async () => {
    const t = setup();
    await t.message('/start');
    // The menu message is gone (e.g. deleted by the user): easytg sends a new one.
    t.responders.editMessageText = () => telegramError('Bad Request: message to edit not found');
    await t.tap('Orders');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('You have 0 order(s).');
  });

  test('broadcasts report users who blocked the bot', async () => {
    const t = setup();
    t.responders.sendMessage = (p) =>
      p.chat_id === 2
        ? telegramError('Forbidden: bot was blocked by the user', { code: 403 })
        : { message_id: 1, date: 1, chat: { id: p.chat_id, type: 'private' }, text: p.text };
    const result = await t.app.broadcast(t.bot, [1, 2, 3], t.orders, { perSecond: 1000 });
    expect(result).toMatchObject({ sent: 2, blocked: 1, blockedChats: [2] });
  });
});

describe('text input and scheduled tasks', () => {
  test('type into a page with onText', async () => {
    const t = createTestBot();
    const app = new EasyTG({ logger: false });
    const search = page<{ q?: string }>('search')
      .render(({ params }) => ({ text: params.q ? `Results for ${params.q}` : 'Type a name', parseMode: 'plain' }))
      .onText(({ text, nav }) => nav.redirect(search, { q: text }));
    app.register(search);
    t.bot.use(app);
    t.bot.command('search', (ctx) => app.open(ctx, search));

    await t.message('/search');
    await t.message('green tea');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Results for green tea');
  });

  test('run due tasks yourself, moving the clock forward', async () => {
    const t = createTestBot();
    const app = new EasyTG({ logger: false });
    const remind = task<{ chatId: number }>('remind').run(async ({ payload, bot }) => {
      await bot.api.sendMessage(payload.chatId, 'Time to stretch!');
    });
    app.register(remind);
    await app.schedule(remind, { chatId: 7 }, { delayMs: 60 * 60_000 });

    expect(await app.runDueTasks(t.bot)).toBe(0); // not due yet
    setSystemTime(new Date(Date.now() + 61 * 60_000)); // an hour later…
    try {
      expect(await app.runDueTasks(t.bot)).toBe(1);
    } finally {
      setSystemTime(); // back to the real clock
    }
    expect(t.find('sendMessage').at(-1)!.payload).toMatchObject({ chat_id: 7, text: 'Time to stretch!' });
  });
});

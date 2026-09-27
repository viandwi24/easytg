import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, page, type Collected, type DialogueFile } from '../src';
import { DIALOGUE_STATE_KEY } from '../src/dialogue';
import { createTestBot } from '../src/testing';

type SignupAnswers = { name: string; plan: 'free' | 'pro'; card?: string };

function setup() {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 } });
  t.bot.use(app);
  const finished: Array<{ answers: SignupAnswers; params: unknown }> = [];
  const cancelled: unknown[] = [];

  const signup = dialogue<SignupAnswers, { source?: string }>('signup')
    .steps(({ answers }) => [
      { id: 'name', type: 'text', text: 'Your name?', validate: (value) => value.length >= 2 || 'Too short' },
      {
        id: 'plan',
        type: 'choice',
        text: 'Plan?',
        columns: 2,
        options: [
          { text: 'Free', value: 'free' },
          { text: 'Pro', value: 'pro' },
        ],
      },
      // Dynamic: only asked for "pro".
      ...(answers.plan === 'pro' ? [{ id: 'card', type: 'text' as const, text: 'Card holder?' }] : []),
    ])
    .onFinish(({ answers, params }) => {
      finished.push({ answers, params });
      return { text: `Welcome ${answers.name}` };
    })
    .onCancel(({ answers }) => {
      cancelled.push(answers);
      return { text: 'Cancelled' };
    });
  const menu = page('menu').render(({ nav }) => ({
    text: 'menu',
    keyboard: [[nav.button('Sign up', signup, { source: 'menu' })]],
  }));
  app.register(signup, menu);
  t.bot.command('signup', (ctx) => app.startDialogue(ctx, signup, { source: 'cmd' }));
  t.bot.command('other', (ctx) => ctx.reply('other'));

  const lastKeyboard = () => t.find('sendMessage').at(-1)!.payload.reply_markup.inline_keyboard as any[][];
  const buttonData = (text: string) => lastKeyboard().flat().find((b: any) => b.text === text)!.callback_data as string;
  return { ...t, app, finished, cancelled, lastKeyboard, buttonData };
}

describe('dialogues', () => {
  test('full flow: validation, choice, dynamic step, onFinish, state cleared', async () => {
    const t = setup();
    await t.message('/signup');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Your name?');
    expect(t.lastKeyboard()).toEqual([[expect.objectContaining({ text: '❌ Cancel' })]]); // no Back on step 1

    t.reset();
    await t.message('x');
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual(['Too short', 'Your name?']);

    t.reset();
    await t.message('Alice');
    expect(t.find('deleteMessages')[0]!.payload.message_ids).toHaveLength(2); // old prompt + error
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Plan?');
    expect(t.lastKeyboard()[0]).toHaveLength(2); // columns: 2
    expect(t.lastKeyboard().at(-1)!.map((b: any) => b.text)).toEqual(['⬅️ Back', '❌ Cancel']);

    await t.press(t.buttonData('Pro'));
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Card holder?');

    await t.message('ALICE A');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Welcome Alice');
    expect(t.finished).toEqual([
      { answers: { name: 'Alice', plan: 'pro', card: 'ALICE A' }, params: { source: 'cmd' } },
    ]);

    const session = await t.app.session({ me: { id: 1 }, chat: { id: 7 }, from: { id: 7 } } as any);
    expect(session.has(DIALOGUE_STATE_KEY)).toBe(false);
    t.reset();
    await t.message('after');
    expect(t.methods()).toEqual([]); // no dialogue consumes messages anymore
  });

  test('back button returns to the previous step and forgets its answer', async () => {
    const t = setup();
    await t.message('/signup');
    await t.message('Alice');
    await t.press(t.buttonData('⬅️ Back'));
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Your name?');
    await t.message('Bob');
    await t.press(t.buttonData('Free'));
    expect(t.finished[0]!.answers).toEqual({ name: 'Bob', plan: 'free' });
  });

  test('wrong input types get a hint and the prompt again', async () => {
    const t = setup();
    await t.message('/signup');
    t.reset();
    await t.message('', { extra: { text: undefined, sticker: { file_id: 'S', file_unique_id: 's' } } });
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual([t.app.texts.expectText, 'Your name?']);
    await t.message('Alice');
    t.reset();
    await t.message('pro'); // typing on a choice step
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual([t.app.texts.expectChoice, 'Plan?']);
  });

  test('forged and stale buttons are rejected', async () => {
    const t = setup();
    await t.message('/signup');
    await t.message('Alice');
    const pro = t.buttonData('Pro');

    t.reset();
    await t.press(pro.replace('v=pro', 'v=enterprise'));
    expect(t.find('answerCallbackQuery')[0]!.payload).toMatchObject({ show_alert: true, text: t.app.texts.buttonExpired });
    expect(t.find('sendMessage')).toHaveLength(0);

    // a new run makes the old run's buttons stale
    await t.message('/signup');
    t.reset();
    await t.press(pro);
    expect(t.find('answerCallbackQuery')[0]!.payload.text).toBe(t.app.texts.buttonExpired);
  });

  test('cancel button renders onCancel in place of the prompt', async () => {
    const t = setup();
    await t.message('/signup');
    await t.message('Alice');
    const promptId = t.sent.at(-1)!.message_id;
    const cancel = t.buttonData('❌ Cancel');
    t.reset();
    await t.press(cancel, { messageId: promptId });
    expect(t.find('editMessageText')[0]!.payload.text).toBe('Cancelled');
    expect(t.cancelled).toEqual([{ name: 'Alice' }]);
    t.reset();
    await t.message('hello');
    expect(t.methods()).toEqual([]);
  });

  test('a /command cancels the dialogue and reaches its handler', async () => {
    const t = setup();
    await t.message('/signup');
    t.reset();
    await t.message('/other');
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual(['other']);
    expect(t.cancelled).toHaveLength(1);
  });

  test('a button can start a dialogue directly (menu is closed)', async () => {
    const t = setup();
    await t.press('p|menu');
    const data = t.find('editMessageText')[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data;
    t.reset();
    await t.press(data);
    expect(t.find('sendMessage')[0]!.payload.text).toBe('Your name?');
    expect(t.methods()).toContain('deleteMessage');
    await t.message('Al');
    await t.press(t.buttonData('Free'));
    expect(t.finished[0]!.params).toEqual({ source: 'menu' });
  });
});

describe('file, collect and actions', () => {
  function setupUpload() {
    const t = createTestBot();
    const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 } });
    t.bot.use(app);
    let result: { otp: string; avatar: DialogueFile; docs: Collected } | undefined;
    let resent = 0;
    const upload = dialogue<{ otp: string; avatar: DialogueFile; docs: Collected }>('upload')
      .steps([
        {
          id: 'otp',
          type: 'text',
          text: 'Code?',
          actions: [{ id: 'resend', text: 'Resend', run: () => (resent++, 'Code sent again') }],
          validate: (code) => code === '1234' || 'Wrong code',
        },
        { id: 'avatar', type: 'file', accept: ['photo'], text: 'Send a photo' },
        { id: 'docs', type: 'collect', text: 'Send documents', accept: ['document', 'text'], min: 1, max: 2 },
      ])
      .onFinish(({ answers }) => void (result = answers));
    app.register(upload);
    t.bot.command('go', (ctx) => app.startDialogue(ctx, upload));
    const buttonData = (text: string) =>
      (t.find('sendMessage').at(-1)!.payload.reply_markup.inline_keyboard as any[][]).flat().find((b) => b.text === text)!
        .callback_data as string;
    return { ...t, app, buttonData, get result() { return result; }, get resent() { return resent; } };
  }

  test('actions run without advancing and show a toast', async () => {
    const t = setupUpload();
    await t.message('/go');
    const resend = t.buttonData('Resend');
    t.reset();
    await t.press(resend);
    expect(t.resent).toBe(1);
    expect(t.find('answerCallbackQuery')[0]!.payload.text).toBe('Code sent again');
    expect(t.find('sendMessage')).toHaveLength(0);
  });

  test('file accept list, collect min/max and final answers', async () => {
    const t = setupUpload();
    await t.message('/go');
    await t.message('1234');

    t.reset();
    await t.message('', { extra: { text: undefined, document: { file_id: 'D0', file_unique_id: 'd0' } } });
    expect(t.find('sendMessage')[0]!.payload.text).toBe(t.app.texts.expectFile);
    await t.message('', { extra: { text: undefined, photo: [{ file_id: 'small', file_unique_id: 's' }, { file_id: 'BIG', file_unique_id: 'b' }] } });
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Send documents');

    const done = t.buttonData('❌ Cancel').replace('k=x', 'k=d'); // Done before sending anything
    t.reset();
    await t.press(done);
    expect(t.find('answerCallbackQuery')[0]!.payload).toMatchObject({ show_alert: true, text: t.app.texts.collectMin(1) });

    await t.message('note');
    await t.message('', { extra: { text: undefined, document: { file_id: 'DOC', file_unique_id: 'u', file_name: 'a.pdf' } } });
    t.reset();
    await t.message('too many');
    expect(t.find('sendMessage')[0]!.payload.text).toContain('at most 2');

    await t.press(t.buttonData('✅ Done'));
    expect(t.result).toEqual({
      otp: '1234',
      avatar: expect.objectContaining({ kind: 'photo', fileId: 'BIG' }),
      docs: { texts: ['note'], files: [expect.objectContaining({ kind: 'document', fileId: 'DOC', fileName: 'a.pdf' })] },
    });
  });
});

describe('middlewares guard dialogues', () => {
  function setupGuarded() {
    const t = createTestBot();
    const app = new EasyTG({
      logger: false,
      buttons: { doubleTapMs: 0 },
      middlewares: [({ ctx, target }, next) => (target.id !== 'broadcast' || ctx.from?.id === 1 ? next() : { text: 'admins only' })],
    });
    t.bot.use(app);
    const broadcast = dialogue('broadcast')
      .allowDeepLink()
      .steps([{ id: 'msg', type: 'text', text: 'Message to all users?' }])
      .onFinish(() => undefined);
    const vip = dialogue('vip')
      .use(({ session }, next) => (session.get('vip') ? next() : { text: 'vip only' }))
      .steps([{ id: 'x', type: 'text', text: 'VIP question?' }])
      .onFinish(() => undefined);
    const launcher = page('launcher').render(({ nav }) => nav.startDialogue(broadcast));
    app.register(broadcast, vip, launcher);
    t.bot.command('go', (ctx) => app.startDialogue(ctx, broadcast));
    const prompts = () => t.find('sendMessage').map((c) => c.payload.text).filter((x) => /\?$/.test(x));
    return { ...t, app, prompts };
  }

  test('forged buttons, deep links, renders and code all go through middlewares', async () => {
    const t = setupGuarded();
    await t.press('p|broadcast', { userId: 666 });
    expect(t.find('editMessageText').at(-1)!.payload.text).toBe('admins only');
    await t.message('/start broadcast', { userId: 666 });
    await t.press('p|launcher', { userId: 666, messageId: 2 });
    await t.message('/go', { userId: 666 });
    expect(t.prompts()).toEqual([]);

    await t.press('p|broadcast', { userId: 1 });
    expect(t.prompts()).toEqual(['Message to all users?']);
  });

  test('dialogue.use() adds per-dialogue middlewares', async () => {
    const t = setupGuarded();
    await t.press('p|vip');
    expect(t.find('editMessageText').at(-1)!.payload.text).toBe('vip only');
    expect(t.prompts()).toEqual([]);
  });
});

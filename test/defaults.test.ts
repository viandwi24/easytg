// Defaults and rules: the production storage warning, presses while busy,
// dialogues without onFinish, the close button's id, guards.
import { afterEach, describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions, type Guard } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, storage: new MemoryStorage(), ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('storage in production', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => void (process.env.NODE_ENV = env));

  const warnings = (options: EasyTGOptions) => {
    const seen: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => void seen.push(m), error() {} };
    new EasyTG({ ...options, logger });
    return seen;
  };

  test('no storage with NODE_ENV=production warns, once, at startup', () => {
    process.env.NODE_ENV = 'production';
    expect(warnings({})).toEqual([expect.stringContaining('kept in memory')]);
    expect(warnings({ storage: new MemoryStorage() })).toEqual([]); // chosen on purpose
    process.env.NODE_ENV = 'development';
    expect(warnings({})).toEqual([]);
  });
});

describe('a button pressed while busy', () => {
  const slow = (views: string[]) =>
    page<{ n?: string }>('slow').render(async ({ params }) => {
      await sleep(30);
      views.push(params.n ?? '');
      return { text: `slow ${params.n}` };
    });

  test("is dropped with the busy toast by default", async () => {
    const views: string[] = [];
    const t = setup();
    t.app.register(slow(views));
    await Promise.all([t.press('p|slow|n=1'), sleep(5).then(() => t.press('p|slow|n=2'))]);
    expect(views).toEqual(['1']);
    expect(t.find('answerCallbackQuery').some((c) => c.payload.text === t.app.texts.busy)).toBe(true);
  });

  test("with whileBusy: 'wait', runs after the previous one", async () => {
    const views: string[] = [];
    const t = setup({ buttons: { whileBusy: 'wait' } });
    t.app.register(slow(views));
    await Promise.all([t.press('p|slow|n=1'), sleep(5).then(() => t.press('p|slow|n=2'))]);
    expect(views).toEqual(['1', '2']);
  });
});

describe('dialogues without onFinish', () => {
  test('register, run and just end; dialogueFinish has the answers', async () => {
    const t = setup();
    const survey = dialogue('survey').steps([{ id: 'name', type: 'text', text: 'Name?' }]);
    t.app.register(survey);
    let answers: unknown;
    t.app.on('dialogueFinish', (e) => void (answers = e.answers));
    t.bot.command('go', (ctx) => t.app.startDialogue(ctx, survey));
    await t.message('/go');
    t.reset();
    await t.message('Ann');
    expect(answers).toEqual({ name: 'Ann' });
    expect(t.find('sendMessage')).toEqual([]);
  });

  test('steps are still required', () => {
    expect(() => new EasyTG().register(dialogue('empty') as never)).toThrow('needs .steps');
  });
});

describe('the close button', () => {
  test('nav.close() sends p|_ex, and "exit" is a normal id now', async () => {
    const t = setup();
    let opened = 0;
    t.app.register(
      page('home').render(({ nav }) => ({ text: 'home', keyboard: [[nav.close()]] })),
      page('exit').render(() => (opened++, { text: 'exit page' })),
    );
    await t.press('p|home');
    expect(t.find('editMessageText')[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe('p|_ex');
    await t.press('p|exit');
    expect(opened).toBe(1);
  });

  test('p|exit under messages sent before still closes them', async () => {
    const t = setup();
    t.app.register(page('home').render(() => ({ text: 'home' })));
    await t.press('p|exit', { messageId: 77 });
    expect(t.methods()).toContain('deleteMessage');
  });
});

describe('guards', () => {
  test('guards runs before renders; middlewares is its old name; not both', async () => {
    const seen: string[] = [];
    const guard: Guard = ({ target }, next) => (seen.push(target.id), next());
    const t = setup({ guards: [guard] });
    t.app.register(page('home').render(() => ({ text: 'home' })));
    await t.press('p|home');
    expect(seen).toEqual(['home']);

    const old = setup({ middlewares: [guard] });
    old.app.register(page('home').render(() => ({ text: 'home' })));
    await old.press('p|home');
    expect(seen).toEqual(['home', 'home']);

    expect(() => new EasyTG({ guards: [guard], middlewares: [guard] })).toThrow('not both');
  });
});

describe('pages opened by a message', () => {
  test('are a new message, not a quote of it', async () => {
    const t = setup();
    const home = page('home').render(() => ({ text: 'home' }));
    t.app.register(home);
    t.bot.command('start', (ctx) => t.app.open(ctx, home));
    await t.message('/start');
    expect(t.find('sendMessage')[0]!.payload.reply_parameters).toBeUndefined();
    t.reset();
    t.bot.command('quote', (ctx) => t.app.open(ctx, home, {}, { mode: 'reply' }));
    await t.message('/quote');
    expect(t.find('sendMessage')[0]!.payload.reply_parameters).toBeDefined();
  });
});

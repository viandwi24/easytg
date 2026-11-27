// app.before, the `errors` options and `dedupeUpdates`.
import { describe, expect, test } from 'bun:test';
import type { Update } from 'grammy/types';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions, type UpdateOutcome } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}, before?: (update: Update) => void) {
  const t = createTestBot();
  if (before) t.bot.use((ctx, next) => (before(ctx.update), next()));
  const app = new EasyTG({ logger: false, storage: new MemoryStorage(), ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const outcomes: UpdateOutcome[] = [];
  app.on('update', ({ outcome }) => void outcomes.push(outcome));
  return { ...t, app, outcomes };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('app.before', () => {
  test('runs inside the lock: what it stores is saved with the update, and stopping ends the update', async () => {
    const t = setup();
    const home = page('home').render(() => ({ text: 'home' }));
    t.app.register(home);
    t.app.before(async (ctx, next) => {
      const session = await t.app.session(ctx);
      session.set('count', (session.get<number>('count') ?? 0) + 1);
      if (ctx.message?.text === 'stop') return; // nothing after this runs
      await next();
    });
    let count: unknown;
    t.bot.command('count', async (ctx) => void (count = (await t.app.session(ctx)).get('count')));
    let reached = 0;
    t.bot.on('message', () => void reached++);

    await t.message('stop');
    await t.message('go');
    expect(reached).toBe(1);
    expect(t.outcomes).toEqual(['easytg', 'next']);
    await t.message('/count');
    expect(count).toBe(3);
  });

  test("a user's second update waits until the first one's before hook is done", async () => {
    const t = setup();
    const order: string[] = [];
    t.app.before(async (ctx, next) => {
      order.push(`start ${ctx.message?.text}`);
      if (ctx.message?.text === 'slow') await sleep(40);
      order.push(`end ${ctx.message?.text}`);
      await next();
    });
    await Promise.all([t.message('slow'), sleep(5).then(() => t.message('fast'))]);
    expect(order).toEqual(['start slow', 'end slow', 'start fast', 'end fast']);
  });

  test('several hooks run in the order added', async () => {
    const t = setup();
    const order: number[] = [];
    t.app.before(async (_ctx, next) => (order.push(1), next())).before(async (_ctx, next) => (order.push(2), next()));
    await t.message('hi');
    expect(order).toEqual([1, 2]);
  });
});

describe('errors', () => {
  const failing = page('boom').render(() => {
    throw new Error('database down');
  });
  const ask = dialogue('ask')
    .steps([{ id: 'n', type: 'text', text: 'Name?' }])
    .onFinish(() => {
      throw new Error('database down');
    });

  test('notify: false stays silent on buttons and messages', async () => {
    const t = setup({ errors: { notify: false } });
    t.app.register(failing, ask);
    t.app.on('error', () => {});
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));
    await t.press('p|boom');
    expect(t.find('answerCallbackQuery')[0]!.payload.text).toBeUndefined();
    await t.message('/ask');
    t.reset();
    await t.message('Ann');
    expect(t.find('sendMessage')).toEqual([]);
  });

  test('notify as a function: an alert on buttons, nothing on messages', async () => {
    const t = setup({ errors: { notify: ({ on }) => on === 'button' } });
    t.app.register(failing, ask);
    t.app.on('error', () => {});
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));
    await t.press('p|boom');
    expect(t.find('answerCallbackQuery')[0]!.payload).toMatchObject({ text: t.app.texts.error, show_alert: true });
    await t.message('/ask');
    t.reset();
    await t.message('Ann');
    expect(t.find('sendMessage')).toEqual([]);
  });

  test('rethrow: the error reaches grammY instead of the error event, and the state is still saved', async () => {
    const t = setup({ errors: { rethrow: true, notify: false } });
    t.app.register(ask);
    const events: unknown[] = [];
    t.app.on('error', ({ error }) => void events.push(error));
    const caught: unknown[] = [];
    const send = (text: string) => t.message(text).catch((error: { error?: unknown }) => void caught.push(error.error));
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));

    await t.message('/ask');
    await send('Ann');
    expect(String(caught[0])).toContain('database down');
    expect(events).toEqual([]);
    expect(t.outcomes.at(-1)).toBe('error');
    // The dialogue kept its answer: onFinish fails again on the next message.
    await send('again');
    expect(caught).toHaveLength(2);
  });
});

describe('dedupeUpdates', () => {
  test('an update delivered again is skipped, also by the next dialogue step', async () => {
    let last: Update | undefined;
    const t = setup({ dedupeUpdates: true }, (update) => void (last = update));
    let answers: unknown;
    const ask = dialogue('ask')
      .steps([
        { id: 'name', type: 'text', text: 'Name?' },
        { id: 'account', type: 'text', text: 'Account id?' },
      ])
      .onFinish(({ answers: a }) => ((answers = a), { text: 'done' }));
    t.app.register(ask);
    t.bot.command('ask', (ctx) => t.app.startDialogue(ctx, ask));

    await t.message('/ask');
    await t.message('Ann');
    const name = last!;
    await t.bot.handleUpdate(name); // delivered again, e.g. after a crash
    expect(t.outcomes.at(-1)).toBe('duplicate');
    await t.message('42');
    expect(answers).toEqual({ name: 'Ann', account: '42' });
  });

  test('a repeated button press is answered and skipped', async () => {
    let last: Update | undefined;
    const t = setup({ dedupeUpdates: true }, (update) => void (last = update));
    let views = 0;
    t.app.register(page('home').render(() => (views++, { text: 'home' })));
    await t.press('p|home');
    await t.bot.handleUpdate(last!);
    expect(views).toBe(1);
    expect(t.find('answerCallbackQuery')).toHaveLength(2);
  });

  test('off by default', async () => {
    let last: Update | undefined;
    const t = setup({}, (update) => void (last = update));
    let views = 0;
    t.app.register(page('home').render(() => (views++, { text: 'home' })));
    await t.press('p|home');
    await t.bot.handleUpdate(last!);
    expect(views).toBe(2);
  });
});

// Storage adapters and the scheduler.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, SqliteStorage, page, task, type EasyTGOptions, type StorageAdapter, type TaskStore } from '../src';
import { createTestBot, telegramError } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const buttons = () => t.calls.filter((c) => c.payload.reply_markup?.inline_keyboard).at(-1)!.payload.reply_markup.inline_keyboard.flat();
  const button = (label: string) => buttons().find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, buttons, button };
}

describe('storage and scheduler', () => {
  test('MemoryStorage behaves like a JSON store', async () => {
    const storage = new MemoryStorage();
    await storage.set('d', { at: new Date(0), set: new Set([1]), n: Number.NaN, u: undefined });
    expect(await (storage as StorageAdapter).get('d')).toEqual({ at: '1970-01-01T00:00:00.000Z', set: {}, n: null });
    expect(storage.set('u', undefined)).rejects.toThrow(/JSON-serializable/);
  });

  test('SQLite with safeIntegers returns numbers', async () => {
    const storage = new SqliteStorage(new Database(':memory:', { safeIntegers: true }));
    await storage.saveTask({ id: 'x', name: 'n', payload: null, runAt: 1, dueAt: 1, attempts: 0, everyMs: 5000, bot: 42 });
    const [claimed] = await storage.claimTasks(2, 1, 10);
    expect(typeof claimed!.everyMs).toBe('number');
    expect(claimed!.bot).toBe(42);
  });

  test("a task whose completion can't be saved doesn't run again right away", async () => {
    const inner = new MemoryStorage();
    let failFinish = true;
    const store: TaskStore = {
      saveTask: (t) => inner.saveTask(t),
      claimTasks: (...args) => inner.claimTasks(...args),
      deleteTask: (id) => inner.deleteTask(id),
      finishTask: (t, next) => (failFinish ? ((failFinish = false), Promise.reject(new Error('busy'))) : inner.finishTask(t, next)),
    };
    const { app, bot } = setup({ scheduler: { store, retryDelayMs: () => 0 } });
    let runs = 0;
    const errors: unknown[] = [];
    app.on('taskError', (e) => void errors.push(e));
    app.register(task('once').run(() => void runs++));
    await app.schedule(task('once'));
    await app.runDueTasks(bot);
    await app.runDueTasks(bot);
    expect(runs).toBe(1);
    expect(errors).toEqual([]);
  });

  test('one slow task does not hold up the others', async () => {
    const { app, bot } = setup({ scheduler: { pollMs: 10 } });
    const order: string[] = [];
    app.register(
      task('slow').run(async () => {
        await Bun.sleep(300);
        order.push('slow');
      }),
      task('fast').run(() => void order.push('fast')),
    );
    await app.schedule(task('slow'));
    await app.schedule(task('fast'), undefined, { delayMs: 50 });
    const stop = app.startScheduler(bot);
    await Bun.sleep(150);
    expect(order).toEqual(['fast']);
    await stop();
    expect(order).toEqual(['fast', 'slow']);
  });

  test("deleteAfterMs follows the message: another page shown in it cancels the deletion", async () => {
    const storage = new MemoryStorage();
    const { app, bot, message, press, button, sent, find, reset } = setup({ storage });
    const other = page('other').render(() => ({ text: 'stays' }));
    const otp = page('otp').render(({ nav }) => ({ text: 'code 1234', deleteAfterMs: 0, keyboard: [[nav.button('go', other)]] }));
    app.register(otp, other);
    bot.command('otp', (ctx) => app.open(ctx, otp));
    await message('/otp');
    await press(button('go'), { messageId: sent.at(-1)!.message_id });
    reset();
    expect(await app.runDueTasks(bot)).toBe(0);
    expect(find('deleteMessages')).toEqual([]);
  });

  test('deleteLater retries rate limits and network errors', async () => {
    const { app, bot, responders } = setup({ scheduler: { retryDelayMs: () => 0 } });
    let calls = 0;
    responders.deleteMessages = () => (++calls === 1 ? telegramError('Too Many Requests: retry after 1', { code: 429, retryAfter: 1 }) : true);
    await app.deleteLater({ chatId: 7 }, [1, 2], { delayMs: 0 });
    await app.runDueTasks(bot);
    await app.runDueTasks(bot);
    expect(calls).toBe(2);
  });

  test('a broadcast does not resend the parts of a page that went out before a 429', async () => {
    const { app, bot, responders, find } = setup();
    app.register(page('long').render(() => ({ text: 'word '.repeat(1500), parseMode: 'plain' })));
    let n = 0;
    responders.sendMessage = (p) =>
      ++n === 2 ? telegramError('Too Many Requests', { code: 429, retryAfter: 0 }) : { message_id: n, date: 1, chat: { id: p.chat_id, type: 'private' } };
    const result = await app.broadcast(bot, [7], page('long'));
    expect(find('sendMessage').length).toBe(2);
    expect(result.failed).toBe(1);
  });
});

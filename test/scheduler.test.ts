import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, SqliteStorage, page, task, type EasyTGOptions, type StorageAdapter, type TaskErrorEvent } from '../src';
import { createTestBot, telegramError } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options });
  t.bot.use(app);
  return { ...t, app };
}

describe('scheduled tasks', () => {
  test('a task runs with its payload once it is due', async () => {
    const { app, bot } = setup();
    const runs: Array<{ payload: unknown; attempts: number }> = [];
    const remind = task<{ text: string }>('remind').run(({ payload, task }) => void runs.push({ payload, attempts: task.attempts }));
    app.register(remind);

    await app.schedule(remind, { text: 'now' });
    await app.schedule(remind, { text: 'later' }, { delayMs: 60_000 });
    expect(await app.runDueTasks(bot)).toBe(1);
    expect(runs).toEqual([{ payload: { text: 'now' }, attempts: 1 }]);
    expect(await app.runDueTasks(bot)).toBe(0); // done tasks are removed
  });

  test('the same id replaces a task; cancelTask removes it', async () => {
    const { app, bot } = setup();
    const seen: unknown[] = [];
    const ping = task<number>('ping').run(({ payload }) => void seen.push(payload));
    app.register(ping);
    await app.schedule(ping, 1, { id: 'daily' });
    await app.schedule(ping, 2, { id: 'daily' });
    const other = await app.schedule(ping, 3);
    expect(await app.cancelTask(other)).toBe(true);
    expect(await app.cancelTask(other)).toBe(false);
    await app.runDueTasks(bot);
    expect(seen).toEqual([2]);
  });

  test('failures are retried with backoff, then dropped', async () => {
    const { app, bot } = setup({ scheduler: { maxAttempts: 2, retryDelayMs: () => 0 } });
    const errors: TaskErrorEvent[] = [];
    app.on('taskError', (event) => void errors.push(event));
    let calls = 0;
    app.register(
      task('flaky').run(() => {
        calls++;
        throw new Error('down');
      }),
    );
    await app.schedule(task('flaky'));
    await app.runDueTasks(bot);
    await app.runDueTasks(bot);
    await app.runDueTasks(bot);
    expect(calls).toBe(2);
    expect(errors.map((e) => [e.task.attempts, e.willRetry])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  test('recurring tasks run again every interval', async () => {
    const storage = new MemoryStorage();
    const { app, bot } = setup({ storage });
    let runs = 0;
    const tick = task('tick').run(() => void runs++);
    app.register(tick);
    const start = Date.now();
    const id = await app.schedule(tick, undefined, { at: start - 10, everyMs: 1000 });
    await app.runDueTasks(bot);
    expect(runs).toBe(1);
    const [next] = await storage.claimTasks(start + 60_000, 10, 1000);
    expect(next).toMatchObject({ id, dueAt: start + 990, attempts: 1 });
  });

  test('startScheduler polls; tasks of several bots run with their own bot', async () => {
    const a = setup();
    const b = createTestBot({ botInfo: { id: 2, username: 'second_bot' } });
    const ran: number[] = [];
    a.app.register(task('who').run(({ bot }) => void ran.push(bot.botInfo.id)));
    await a.app.schedule(task('who'), undefined, { botId: 2 });
    await a.app.schedule(task('who'));
    const stop = a.app.startScheduler(a.bot, b.bot);
    await Bun.sleep(30);
    await stop();
    expect(ran.sort()).toEqual([1, 2]);
  });

  test('deleteLater, deleteAfterMs and sendLater', async () => {
    const { app, bot, message, find, reset, sent } = setup();
    const note = page('note').render(() => ({ text: 'self-destructs', deleteAfterMs: 0 }));
    const reminder = page<{ n: string }>('reminder').render(({ params }) => ({ text: `reminder ${params.n}`, parseMode: 'plain' }));
    app.register(note, reminder);
    bot.command('note', (ctx) => app.open(ctx, note));
    bot.command('bye', async (ctx) => {
      const reply = await ctx.reply('bye');
      await app.deleteLater(ctx, reply.message_id, { delayMs: 0 });
    });

    await message('/note');
    const noteId = sent.at(-1)!.message_id;
    await message('/bye');
    const byeId = sent.at(-1)!.message_id;
    await app.sendLater(42, reminder, { params: { n: '1' } });
    reset();
    await app.runDueTasks(bot);
    expect(find('deleteMessages').map((c) => c.payload)).toEqual([
      { chat_id: 7, message_ids: [noteId] },
      { chat_id: 7, message_ids: [byeId] },
    ]);
    expect(find('sendMessage').map((c) => [c.payload.chat_id, c.payload.text])).toEqual([[42, 'reminder 1']]);
  });

  test('blocked users and missing messages are not retried', async () => {
    const { app, bot, responders } = setup({ scheduler: { retryDelayMs: () => 0 } });
    const errors: unknown[] = [];
    app.on('taskError', (e) => void errors.push(e));
    app.register(page('p').render(() => ({ text: 'p' })));
    responders.sendMessage = () => telegramError('Forbidden: bot was blocked by the user', { code: 403 });
    responders.deleteMessages = () => telegramError('Bad Request: message to delete not found');
    await app.sendLater(42, 'p', {});
    await app.deleteLater({ chatId: 42 }, [1, 2], { delayMs: 0 });
    await app.runDueTasks(bot);
    expect(await app.runDueTasks(bot)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('tasks survive a restart and are claimed once across processes (SQLite)', async () => {
    const db = new Database(':memory:');
    const first = setup({ storage: new SqliteStorage(db) });
    const job = task<number>('job');
    await expect(first.app.schedule(job, 1)).rejects.toThrow(/not registered/);
    first.app.register(task<number>('job').run(() => {}));
    for (let i = 0; i < 10; i++) await first.app.schedule(task<number>('job'), i);

    // "Restart": two new processes on the same database.
    const seen: number[] = [];
    const procs = [setup({ storage: new SqliteStorage(db) }), setup({ storage: new SqliteStorage(db) })];
    for (const p of procs) p.app.register(task<number>('job').run(({ payload }) => void seen.push(payload)));
    await Promise.all(procs.map((p) => p.app.runDueTasks(p.bot)));
    expect(seen.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('a storage without task support fails clearly', async () => {
    const plain: StorageAdapter = { get: async () => null, set: async () => {}, delete: async () => {} };
    const { app } = setup({ storage: plain });
    app.register(task('x').run(() => {}));
    await expect(app.schedule(task('x'))).rejects.toThrow(/TaskStore/);
  });
});

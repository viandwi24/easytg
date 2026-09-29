import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, QueueFullError, QueueTimeoutError, page, type EasyTGOptions, type StorageAdapter } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options });
  t.bot.use(app);
  return { ...t, app };
}

/** Two "processes" (app instances) of the same bot sharing one storage. */
function twoProcesses(options: EasyTGOptions = {}) {
  const storage = new MemoryStorage();
  return [setup({ storage, cluster: true, ...options }), setup({ storage, cluster: true, ...options })] as const;
}

describe('sequential updates', () => {
  test("one user's updates run one at a time, in order; other users run in parallel", async () => {
    const { bot, message } = setup();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    bot.on('message:text', async (ctx) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${ctx.from.id}:${ctx.message.text}`);
      await Bun.sleep(ctx.message.text === 'a' ? 30 : 5);
      log.push(`end ${ctx.from.id}:${ctx.message.text}`);
      running--;
    });
    await Promise.all([message('a'), message('b'), message('c'), message('x', { userId: 8 })]);
    const user7 = log.filter((l) => l.includes(' 7:'));
    expect(user7).toEqual(['start 7:a', 'end 7:a', 'start 7:b', 'end 7:b', 'start 7:c', 'end 7:c']);
    expect(maxRunning).toBe(2); // user 8 didn't wait for user 7
  });

  test('sequential: false lets updates overlap', async () => {
    const { bot, message } = setup({ sequential: false });
    let running = 0;
    let maxRunning = 0;
    bot.on('message:text', async () => {
      maxRunning = Math.max(maxRunning, ++running);
      await Bun.sleep(10);
      running--;
    });
    await Promise.all([message('a'), message('b')]);
    expect(maxRunning).toBe(2);
  });

  test('an update waits at most timeoutMs, then runs anyway', async () => {
    const { bot, message } = setup({ sequential: { timeoutMs: 20 } });
    const log: string[] = [];
    bot.on('message:text', async (ctx) => {
      log.push(`start ${ctx.message.text}`);
      if (ctx.message.text === 'slow') await Bun.sleep(80);
    });
    await Promise.all([message('slow'), Bun.sleep(1).then(() => message('fast'))]);
    expect(log).toEqual(['start slow', 'start fast']);
  });

  test('concurrent updates no longer lose session writes', async () => {
    const { app, bot, message } = setup();
    let items: unknown;
    bot.command('show', async (ctx) => void (items = (await app.session(ctx)).get('items')));
    bot.on('message:text', async (ctx) => {
      const session = await app.session(ctx);
      const items = session.get<string[]>('items') ?? [];
      await Bun.sleep(5); // e.g. a database call
      session.set('items', [...items, ctx.message.text]);
    });
    await Promise.all(['a', 'b', 'c', 'd'].map((text) => message(text)));
    await message('/show');
    expect(items).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('cluster', () => {
  test('needs a storage with atomic operations', () => {
    const plain: StorageAdapter = { get: async () => null, set: async () => {}, delete: async () => {} };
    expect(() => new EasyTG({ storage: plain, cluster: true })).toThrow(/increment\(\) and setIfAbsent\(\)/);
    expect(() => new EasyTG({ storage: plain, cluster: new MemoryStorage() })).not.toThrow();
  });

  test('the rate limit counts updates from every process', async () => {
    const [a, b] = twoProcesses({ antiSpam: { limit: 3, warn: false } });
    let handled = 0;
    a.bot.on('message', () => void handled++);
    b.bot.on('message', () => void handled++);
    await a.message('1');
    await b.message('2');
    await a.message('3');
    await b.message('4'); // 4th in the window: limited
    await a.message('5');
    expect(handled).toBe(3);
    expect(await b.app.isLimited(7)).toBe(true);
    await a.app.releaseUser(7);
    expect(await b.app.isLimited(7)).toBe(false);
  });

  test('limitUser in one process applies in the others', async () => {
    const [a, b] = twoProcesses();
    let handled = 0;
    b.bot.on('message', () => void handled++);
    await a.app.limitUser(7, 60_000);
    await b.message('hi');
    expect(handled).toBe(0);
  });

  test('a press while another process handles the same user gets the busy toast', async () => {
    const [a, b] = twoProcesses();
    let renders = 0;
    for (const { app } of [a, b]) {
      app.register(
        page('slow').render(async () => {
          renders++;
          await Bun.sleep(40);
          return { text: 'done' };
        }),
      );
    }
    await Promise.all([a.press('p|slow'), Bun.sleep(5).then(() => b.press('p|slow', { messageId: 501 }))]);
    expect(renders).toBe(1);
    expect(b.find('answerCallbackQuery').map((c) => c.payload.text)).toContain(b.app.texts.busy);
  });

  test('double taps are detected across processes', async () => {
    const [a, b] = twoProcesses();
    let renders = 0;
    for (const { app } of [a, b]) app.register(page('p').render(() => ((renders += 1), { text: 'p' })));
    await a.press('p|p');
    await b.press('p|p'); // same button right after: ignored
    expect(renders).toBe(1);
  });

  test('messages of one user are handled one at a time across processes', async () => {
    const [a, b] = twoProcesses();
    let running = 0;
    let maxRunning = 0;
    for (const { bot } of [a, b]) {
      bot.on('message', async () => {
        maxRunning = Math.max(maxRunning, ++running);
        await Bun.sleep(30);
        running--;
      });
    }
    await Promise.all([a.message('1'), b.message('2')]);
    expect(maxRunning).toBe(1);
  });

  test('queue slots are shared', async () => {
    const [a, b] = twoProcesses({ queues: { ai: { concurrency: 1 } } });
    let running = 0;
    let maxRunning = 0;
    const waits: Array<number | undefined> = [];
    b.app.on('queueWait', ({ position }) => void waits.push(position));
    const job = async () => {
      maxRunning = Math.max(maxRunning, ++running);
      await Bun.sleep(30);
      running--;
    };
    await Promise.all([a.app.queue('ai', job), Bun.sleep(5).then(() => b.app.queue('ai', job))]);
    expect(maxRunning).toBe(1);
    expect(waits).toEqual([undefined]); // position isn't known across processes
  });
});

describe('queues', () => {
  test('limits concurrency and serves waiters in order', async () => {
    const { app } = setup({ queues: { ai: { concurrency: 2 } } });
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const positions: Array<number | undefined> = [];
    app.on('queueWait', ({ position }) => void positions.push(position));
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        app.queue('ai', async () => {
          maxRunning = Math.max(maxRunning, ++running);
          order.push(n);
          await Bun.sleep(10);
          running--;
          return n * 10;
        }),
      ),
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(maxRunning).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(positions).toEqual([1, 2, 3]);
  });

  test('a failing job frees its slot', async () => {
    const { app } = setup({ queues: { q: { concurrency: 1 } } });
    await expect(app.queue('q', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await app.queue('q', () => 'ok')).toBe('ok');
  });

  test('maxWaiting, perUser and timeoutMs reject jobs', async () => {
    const { app, bot, message } = setup({
      queues: { full: { concurrency: 1, maxWaiting: 1 }, mine: { concurrency: 5, perUser: 1 }, slow: { concurrency: 1, timeoutMs: 20 } },
    });
    const hold = (name: string) => app.queue(name, () => Bun.sleep(50));

    const first = hold('full');
    const second = hold('full');
    await expect(hold('full')).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all([first, second]);

    const slow = hold('slow');
    await expect(hold('slow')).rejects.toBeInstanceOf(QueueTimeoutError);
    await slow;

    const errors: unknown[] = [];
    bot.on('message', async (ctx) => {
      await app.queue('mine', () => Bun.sleep(30), { ctx }).catch((error) => void errors.push(error));
    });
    await Promise.all([message('a', { userId: 1 }), message('b', { userId: 1, chatId: 99 }), message('c', { userId: 2 })]);
    expect(errors.length).toBe(1);
    expect((errors[0] as QueueFullError).reason).toBe('perUser');
  });

  test('enterQueue holds a slot until the update is handled', async () => {
    const { app, bot, message } = setup({ queues: { ai: { concurrency: 1 } } });
    let running = 0;
    let maxRunning = 0;
    bot.on('message', async (ctx) => {
      await app.enterQueue(ctx, 'ai');
      maxRunning = Math.max(maxRunning, ++running);
      await Bun.sleep(20);
      running--;
    });
    await Promise.all([message('a', { userId: 1 }), message('b', { userId: 2 })]);
    expect(maxRunning).toBe(1);
    expect(await app.queue('ai', () => 'free again')).toBe('free again');
  });

  test('misuse is reported clearly', async () => {
    const { app, bot } = setup({ queues: { ai: { concurrency: 1 } } });
    await expect(app.queue('nope', () => 1)).rejects.toThrow(/not configured/);
    await bot.init();
    const outside = { me: bot.botInfo, from: { id: 1 } } as never;
    await expect(app.enterQueue(outside, 'ai')).rejects.toThrow(/while handling an update/);
    expect(() => new EasyTG({ queues: { bad: { concurrency: 0 } } })).toThrow(/at least 1/);
  });
});

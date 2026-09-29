import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, page, type EasyTGOptions, type SpamEvent } from '../src';
import { Session } from '../src/session';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

describe('session expiry', () => {
  test('per-key TTL', async () => {
    const session = new Session();
    session.set('otp', '1234', { ttlMs: 50 });
    session.set('name', 'Ann');
    expect(session.get<string>('otp')).toBe('1234');
    await Bun.sleep(60);
    expect(session.get('otp')).toBeUndefined();
    expect(session.has('otp')).toBe(false);
    expect(session.keys()).toEqual(['name']);
    session.set('otp', 'again'); // set without TTL: permanent again
    await Bun.sleep(60);
    expect(session.get<string>('otp')).toBe('again');
  });

  test('per-key TTL survives storage round trips', async () => {
    const { app, bot, message } = setup();
    let seen: unknown[] = [];
    bot.command('set', async (ctx) => (await app.session(ctx)).set('otp', '1234', { ttlMs: 80 }));
    bot.command('get', async (ctx) => void seen.push((await app.session(ctx)).get('otp')));
    await message('/set');
    await message('/get');
    await Bun.sleep(100);
    await message('/get');
    expect(seen).toEqual(['1234', undefined]);
  });

  test('session TTL is refreshed by activity, not only by writes', async () => {
    const storage = new MemoryStorage();
    const { app, bot, message } = setup({ storage, session: { ttlMs: 200 } });
    const seen: unknown[] = [];
    bot.command('set', async (ctx) => (await app.session(ctx)).set('k', 'v'));
    bot.command('get', async (ctx) => void seen.push((await app.session(ctx)).get('k')));

    await message('/set');
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(120); // > half the TTL: this read refreshes it
      await message('/get');
    }
    expect(seen).toEqual(['v', 'v', 'v', 'v']); // alive after 480ms with a 200ms TTL

    await Bun.sleep(250); // idle longer than the TTL
    await message('/get');
    expect(seen.at(-1)).toBeUndefined();
  });

  test('without refreshOnActivity only writes extend the TTL', async () => {
    const { app, bot, message } = setup({ session: { ttlMs: 200, refreshOnActivity: false } });
    const seen: unknown[] = [];
    bot.command('set', async (ctx) => (await app.session(ctx)).set('k', 'v'));
    bot.command('get', async (ctx) => void seen.push((await app.session(ctx)).get('k')));
    await message('/set');
    await Bun.sleep(120);
    await message('/get');
    await Bun.sleep(120);
    await message('/get');
    expect(seen).toEqual(['v', undefined]);
  });

  test('reads without activity refresh do not write', async () => {
    let writes = 0;
    const inner = new MemoryStorage();
    const storage = { get: (k: string) => inner.get(k), set: (k: string, v: unknown, t?: number) => ((writes++), inner.set(k, v, t)), delete: (k: string) => inner.delete(k) };
    const { app, bot, message } = setup({ storage, session: { ttlMs: 60_000 } });
    bot.command('set', async (ctx) => (await app.session(ctx)).set('k', 'v'));
    bot.command('get', async (ctx) => void (await app.session(ctx)).get('k'));
    await message('/set');
    await message('/get');
    await message('/get');
    expect(writes).toBe(1);
  });
});

describe('anti-spam', () => {
  test('limits a flooding user, warns once, emits an event', async () => {
    const { app, bot, message, press, find } = setup({ antiSpam: { limit: 3, windowMs: 1000, cooldownMs: 100 } });
    const events: SpamEvent[] = [];
    app.on('spam', (e) => void events.push(e));
    let handled = 0;
    bot.on('message', () => void handled++);
    app.register(page('p').render(() => ({ text: 'p' })));

    for (let i = 0; i < 6; i++) await message(`hi ${i}`);
    expect(handled).toBe(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: 7, chatId: 7, count: 4, windowMs: 1000, strike: 1 });
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual([app.texts.spam(1)]); // one warning

    await press('p|p'); // still limited: spinner stopped silently, page not opened
    expect(find('answerCallbackQuery').at(-1)!.payload.text).toBeUndefined();
    expect(find('editMessageText')).toHaveLength(0);
    expect(await app.isLimited(7)).toBe(true);

    await Bun.sleep(110);
    await message('back');
    expect(handled).toBe(4);
  });

  test('strikes accumulate; listeners can escalate or release', async () => {
    const { app, bot, message } = setup({ antiSpam: { limit: 1, windowMs: 1000, cooldownMs: 20, warn: false } });
    const strikes: number[] = [];
    app.on('spam', async ({ userId, strike }) => {
      strikes.push(strike);
      if (strike >= 2) await app.limitUser(userId, 60_000); // "ban"
    });
    let handled = 0;
    bot.on('message', () => void handled++);

    await message('a');
    await message('b'); // strike 1
    await Bun.sleep(30);
    await message('c');
    await message('d'); // strike 2 -> long limit
    await Bun.sleep(30);
    await message('e');
    expect(strikes).toEqual([1, 2]);
    expect(handled).toBe(2);
    expect(await app.isLimited(7)).toBe(true);

    await app.releaseUser(7);
    await message('f');
    expect(handled).toBe(3);
  });

  test('a listener can silence the default warning for one incident', async () => {
    const { app, message, find } = setup({ antiSpam: { limit: 1, windowMs: 1000, cooldownMs: 20 } });
    app.on('spam', (e) => {
      if (e.strike >= 2) e.silence();
    });
    await message('a');
    await message('b'); // strike 1: warned
    await Bun.sleep(30);
    await message('c');
    await message('d'); // strike 2: silenced
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual([app.texts.spam(1)]);
  });

  test('a listener releasing the user lets the update through', async () => {
    const { app, bot, message } = setup({ antiSpam: { limit: 1, windowMs: 1000 } });
    app.on('spam', ({ userId }) => app.releaseUser(userId)); // e.g. only log it
    let handled = 0;
    bot.on('message', () => void handled++);
    await message('a');
    await message('b');
    expect(handled).toBe(2);
  });

  test('exempt users, disabled anti-spam, group chats', async () => {
    const exempt = setup({ antiSpam: { limit: 1, exempt: (ctx) => ctx.from?.id === 7 } });
    let a = 0;
    exempt.bot.on('message', () => void a++);
    for (let i = 0; i < 5; i++) await exempt.message('x');
    expect(a).toBe(5);

    const off = setup({ antiSpam: false });
    let b = 0;
    off.bot.on('message', () => void b++);
    for (let i = 0; i < 30; i++) await off.message('x');
    expect(b).toBe(30);
    await off.app.limitUser(7, 1000); // manual limits still work
    await off.message('x');
    expect(b).toBe(30);

    const group = setup({ antiSpam: { limit: 1 } });
    await group.message('x', { chatType: 'group' });
    await group.message('x', { chatType: 'group' });
    expect(group.find('sendMessage')).toHaveLength(0); // no warning replies in groups
  });

  test('button flood gets an alert toast', async () => {
    const { app, press, find } = setup({ antiSpam: { limit: 2, cooldownMs: 1000 } });
    app.register(page('p').render(() => ({ text: 'p' })));
    await press('p|p');
    await press('p|p', { messageId: 2 });
    await press('p|p', { messageId: 3 });
    expect(find('answerCallbackQuery').at(-1)!.payload).toMatchObject({ show_alert: true, text: app.texts.spam(1) });
  });
});

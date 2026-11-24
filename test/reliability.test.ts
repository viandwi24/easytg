/**
 * What must hold when things go wrong or overlap: slow handlers, failed sends,
 * a failing onFinish. Driven through the simulator, like a real chat.
 */
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page } from '../src';
import { TelegramSimulator } from '../packages/simulator/src';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('sessions', () => {
  test('two overlapping updates of one chat both keep their changes (past the lock wait)', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const storage = new MemoryStorage();
    const app = new EasyTG({ storage, sequential: { timeoutMs: 30 } });
    bot.use(app);
    bot.command('slow', async (ctx) => {
      const session = await app.session(ctx);
      await sleep(120); // still running when /fast arrives and stops waiting for it
      session.set('slow', 1);
    });
    bot.command('fast', async (ctx) => (await app.session(ctx)).set('fast', 1));

    const slow = sim.send('/slow');
    await sleep(10);
    await sim.send('/fast');
    await slow;

    let seen: unknown;
    bot.command('show', async (ctx) => void (seen = (await app.session(ctx)).toJSON()));
    await sim.send('/show');
    expect(seen).toMatchObject({ slow: 1, fast: 1 });
  });

  test('a value changed in place, without set, is saved', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG({ storage: new MemoryStorage() });
    bot.use(app);
    bot.command('init', async (ctx) => (await app.session(ctx)).set('cart', ['a']));
    bot.command('add', async (ctx) => void (await app.session(ctx)).get<string[]>('cart')!.push('b'));
    let cart: unknown;
    bot.command('show', async (ctx) => void (cart = (await app.session(ctx)).get('cart')));

    await sim.send('/init');
    await sim.send('/add');
    await sim.send('/show');
    expect(cart).toEqual(['a', 'b']);
  });

  test('in place changes in userSession are merged, not lost', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG({ storage: new MemoryStorage() });
    bot.use(app);
    bot.command('init', async (ctx) => (await app.userSession(ctx)).set('tags', { a: true }));
    bot.command('add', async (ctx) => void ((await app.userSession(ctx)).get<Record<string, boolean>>('tags')!.b = true));
    let tags: unknown;
    bot.command('show', async (ctx) => void (tags = (await app.userSession(ctx)).get('tags')));
    await sim.send('/init');
    await sim.send('/add');
    await sim.send('/show');
    expect(tags).toEqual({ a: true, b: true });
  });
});

describe('replacing a message that cannot be edited', () => {
  test('the new message is sent first: when that fails, the old menu stays', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    let failNextSend = false;
    bot.api.config.use((prev, method, payload, signal) => {
      if (failNextSend && method === 'sendMessage') {
        failNextSend = false;
        throw new Error('network down');
      }
      return prev(method, payload, signal);
    });
    const app = new EasyTG({ buttons: { doubleTapMs: 0 } }); // the same button twice in a row, on purpose
    const list = page('list').render(() => ({ text: 'A list' }));
    const card = page('card').render(({ nav }) => ({ photo: 'https://example.com/a.png', text: 'A card', keyboard: [[nav.button('List', list)]] }));
    app.register(card, list);
    bot.use(app);
    bot.command('start', (ctx) => app.open(ctx, card));
    sim.on('error', () => undefined);

    await sim.send('/start');
    const menu = sim.last()!.message.message_id;
    failNextSend = true; // photo -> text replaces the message: its send fails
    await sim.tap('List').catch(() => undefined);
    expect(sim.last()!.message.message_id).toBe(menu); // nothing new was sent
    expect(sim.messages().some((m) => m.message.message_id === menu)).toBe(true); // still there, still usable

    await sim.tap('List'); // works now
    expect(sim.last()!.message.text).toBe('A list');
    expect(sim.messages().some((m) => m.message.message_id === menu)).toBe(false); // replaced
  });
});

describe('dialogue onFinish', () => {
  test('a failing onFinish keeps the answers; the next message tries again', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG({ storage: new MemoryStorage() });
    let attempts = 0;
    const finished: string[] = [];
    const signup = dialogue<{ name: string; city: string }>('signup')
      .steps([
        { id: 'name', type: 'text', text: 'Your name?' },
        { id: 'city', type: 'text', text: 'Your city?' },
      ])
      .onFinish(({ answers }) => {
        attempts++;
        if (attempts === 1) throw new Error('database down');
        return { text: `Saved ${answers.name} from ${answers.city}` };
      });
    app.register(signup);
    app.on('dialogueFinish', ({ dialogue: id }) => void finished.push(id));
    bot.use(app);
    bot.command('start', (ctx) => app.startDialogue(ctx, signup));
    sim.on('error', () => undefined);

    await sim.send('/start');
    await sim.send('Ana');
    await sim.send('Jakarta'); // onFinish fails
    expect(attempts).toBe(1);
    expect(finished).toEqual([]); // not reported as finished

    await sim.send('again'); // the dialogue is still there, complete: finishing again
    expect(attempts).toBe(2);
    expect(sim.last()!.message.text).toBe('Saved Ana from Jakarta');
    expect(finished).toEqual(['signup']);
  });

  test('onFinish may start another dialogue: it stays', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG({ storage: new MemoryStorage() });
    const second = dialogue<{ b: string }>('second')
      .steps([{ id: 'b', type: 'text', text: 'Second?' }])
      .onFinish(({ answers }) => ({ text: `Second: ${answers.b}` }));
    const first = dialogue<{ a: string }>('first')
      .steps([{ id: 'a', type: 'text', text: 'First?' }])
      .onFinish(async ({ ctx, app: easytg }) => {
        await easytg.startDialogue(ctx, second);
        return undefined;
      });
    app.register(first, second);
    bot.use(app);
    bot.command('start', (ctx) => app.startDialogue(ctx, first));

    await sim.send('/start');
    await sim.send('one');
    expect(sim.last()!.message.text).toBe('Second?');
    await sim.send('two');
    expect(sim.last()!.message.text).toBe('Second: two');
  });
});

describe('SqliteStorage', () => {
  test('purges expired keys during a write, at most every purgeEveryMs', async () => {
    const { Database } = await import('bun:sqlite');
    const { SqliteStorage } = await import('../src');
    const db = new Database(':memory:');
    const storage = new SqliteStorage(db, { purgeEveryMs: 50 });
    await storage.set('old', 1, 10);
    await sleep(60);
    const rows = () => (db.query('SELECT COUNT(*) AS n FROM easytg_kv').get() as { n: number }).n;
    expect(rows()).toBe(1); // expired, still on disk
    await storage.set('new', 2); // a write after purgeEveryMs: purged
    expect(rows()).toBe(1);
    expect(await storage.get('old')).toBeNull();
    expect(await storage.get('new')).toBe(2);
  });
});

describe('validation and leftovers', () => {
  test("dialogue buttons too long for callback data work in 'inline' mode (stored)", async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG({ storage: new MemoryStorage(), buttons: { params: 'inline' } });
    const long = 'x'.repeat(80);
    const pick = dialogue<{ v: string }>('pick')
      .steps([{ id: 'v', type: 'choice', text: 'Pick', options: [{ text: 'Long one', value: long }] }])
      .onFinish(({ answers }) => ({ text: `Got ${answers.v.length}` }));
    app.register(pick);
    bot.use(app);
    bot.command('start', (ctx) => app.startDialogue(ctx, pick));
    await sim.send('/start');
    await sim.tap('Long one');
    expect(sim.last()!.message.text).toBe('Got 80');
  });

  test('a too short refreshEveryMs fails before anything is sent', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG();
    const live = page('live').render(() => ({ text: 'Live', refreshEveryMs: 1000 }));
    app.register(live);
    bot.use(app);
    const errors: unknown[] = [];
    bot.command('start', (ctx) => app.open(ctx, live).catch((error: unknown) => void errors.push(error)));
    await sim.send('/start');
    expect(String(errors[0])).toContain('refreshEveryMs must be at least 5000');
    expect(sim.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  test('app.stream in a group: a source failing before its first word leaves no "…" behind', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const app = new EasyTG();
    bot.use(app);
    const group = sim.createGroup({ title: 'G' });
    bot.command('ask', (ctx) =>
      app
        .stream(ctx, (async function* () {
          throw new Error('model down');
        })())
        .catch(() => undefined),
    );
    await sim.send('/ask', { chat: group.id });
    expect(sim.messages(group.id).filter((m) => m.fromBot)).toHaveLength(0);
  });
});

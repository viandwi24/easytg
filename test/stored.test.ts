import { describe, expect, test } from 'bun:test';
import {
  EasyTG,
  page,
  dialogue,
  MemoryStorage,
  isProactive,
  paginate,
  type EasyTGOptions,
  type StorageAdapter,
} from '../src';
import { createTestBot, verifyStorageAdapter } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const buttons = (payload: any): string[] => payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

describe('callbackParams: auto (default)', () => {
  test('short params inline, long params stored; same button → same token', async () => {
    const { app, press, find } = setup();
    let received: unknown;
    const list = page<{ q?: string; sort?: string }>('list').render(({ params, nav }) => {
        received = params;
        return {
          text: 'list',
          keyboard: [[nav.self('short', { q: 'a' }), nav.self('long', { q: 'x'.repeat(100), sort: 'name' })]],
        };
      });
    app.register(list);

    await press('p|list');
    const [short, long] = buttons(find('editMessageText')[0]!.payload);
    expect(short).toBe('p|list|q=a');
    expect(long).toMatch(/^s\|[A-Za-z0-9_-]{16}$/);

    await press(long!);
    expect(received).toEqual({ q: 'x'.repeat(100), sort: 'name' });
    expect(buttons(find('editMessageText')[1]!.payload)[1]).toBe(long);
  });

  test('stored buttons belong to the user they were rendered for', async () => {
    const { app, press, find, reset } = setup();
    const p = page('p').render(({ nav }) => ({ text: 'p', keyboard: [[nav.self('x', { n: 1 }, { store: true })]] }));
    app.register(p);
    await press('p|p', { userId: 1 });
    const token = buttons(find('editMessageText')[0]!.payload)[0]!;
    reset();
    await press(token, { userId: 2 });
    expect(find('answerCallbackQuery')[0]!.payload.text).toBe(app.texts.notYourMenu);
    expect(find('editMessageText')).toHaveLength(0);
  });

  test('unknown tokens are rejected', async () => {
    const { app, press, find } = setup();
    await press('s|AAAAAAAAAAAAAAAA');
    expect(find('answerCallbackQuery')[0]!.payload.text).toBe(app.texts.buttonExpired);
  });

  test('nav outside a render: stored buttons are saved when the update ends', async () => {
    const { app, bot, message, press } = setup();
    let got: unknown;
    const p = page('p').render(({ params }) => ((got = params), { text: 'p' }));
    app.register(p);
    let data = '';
    bot.command('go', async (ctx) => {
      data = app.nav(ctx).data(p, { big: 'z'.repeat(90) });
      await ctx.reply('manual', { reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: data }]] } });
    });
    await message('/go');
    await press(data);
    expect(got).toEqual({ big: 'z'.repeat(90) });
  });
});

describe('callbackParams: stored', () => {
  test('params always stored; forged inline params rejected; dialogues still work', async () => {
    const { app, press, message, find, reset } = setup({ buttons: { params: 'stored' } });
    const seen: unknown[] = [];
    const home = page('home').render(() => ({ text: 'home' }));
    const d = dialogue('d')
      .steps([{ id: 'a', type: 'choice', text: 'A?', options: [{ text: 'Yes', value: 'y' }] }])
      .onFinish(({ answers }) => ({ text: `done ${answers.a}` }));
    const order = page<{ id?: string }>('order').render(({ params, nav }) => {
        seen.push(params);
        return { text: 'order', keyboard: [[nav.self('next', { id: 2 }), nav.home(), nav.close(), nav.button('start', d)]] };
      });
    app.register(home, order, d);

    await press('p|order|id=1'); // forged
    expect(seen).toHaveLength(0);
    expect(find('answerCallbackQuery')[0]!.payload.text).toBe(app.texts.buttonExpired);

    reset();
    await press('p|order');
    const [next, homeBtn, close, start] = buttons(find('editMessageText')[0]!.payload);
    expect(next).toMatch(/^s\|/);
    expect([homeBtn, close, start]).toEqual(['p|home', 'p|exit', 'p|d']);
    await press(next!);
    expect(seen.at(-1)).toEqual({ id: '2' });

    await press(start!);
    const yes = buttons(find('sendMessage').at(-1)!.payload)[0]!;
    await press(yes);
    expect(find('sendMessage').at(-1)!.payload.text).toBe('done y');
    expect(message).toBeDefined();
  });

  test('pagination', async () => {
    const { app, press, find } = setup({ buttons: { params: 'stored' } });
    const items = Array.from({ length: 25 }, (_, i) => `item ${i + 1}`);
    app.register(
      page('items').render((args) => {
          const { offset, limit, page, buttons } = paginate(args, { total: items.length, perPage: 10 });
          return { text: [`page ${page}`, ...items.slice(offset, offset + limit)], keyboard: [buttons] };
        }),
    );
    await press('p|items');
    const first = find('editMessageText')[0]!.payload;
    expect(first.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['1 / 3', '➡️', '⏭️']);
    await press(buttons(first).at(-1)!); // ⏭️
    const last = find('editMessageText')[1]!.payload;
    expect(last.text.split('\n')).toEqual(['page 3', 'item 21', 'item 22', 'item 23', 'item 24', 'item 25']);
  });

  test('paginate clamps untrusted numbers', () => {
    const nav = { self: (text: string, p: any) => ({ text, callback_data: String(p.page) }) } as any;
    const run = (page?: string) => paginate({ params: { page }, nav }, { total: 50, perPage: 10 }).page;
    expect([run(undefined), run('3'), run('999'), run('-4'), run('abc')]).toEqual([1, 3, 5, 1, 1]);
  });
});

describe('storage adapters', () => {
  function recording(name: string, log: string[]): StorageAdapter {
    const inner = new MemoryStorage();
    return {
      get: (key) => (log.push(`${name}.get ${key}`), inner.get(key)),
      set: (key, value, ttl) => (log.push(`${name}.set ${key}`), inner.set(key, value, ttl)),
      delete: (key) => (log.push(`${name}.delete ${key}`), inner.delete(key)),
    };
  }

  test('per-concern adapters and key prefix', async () => {
    const log: string[] = [];
    const { app, message, bot } = setup({
      storage: recording('default', log),
      buttons: { storage: recording('callbacks', log) },
      keyPrefix: 'bot1:',
    });
    const menu = page('menu').render(({ session, nav }) => {
        session.set('seen', true);
        return { text: 'm', keyboard: [[nav.self('x', { n: 1 }, { store: true })]] };
      });
    app.register(menu);
    bot.command('menu', (ctx) => app.open(ctx, menu));
    await message('/menu', { userId: 5, chatType: 'group' });

    expect(log.some((l) => l.startsWith('callbacks.set bot1:cb:'))).toBe(true);
    expect(log).toContain('default.set bot1:session:-100:5');
    expect(log.some((l) => l.startsWith('callbacks.set bot1:msgowner:-100:'))).toBe(true); // menu metadata lives with buttons
    expect(log.some((l) => l.startsWith('default.set bot1:cb:'))).toBe(false);
  });

  test('verifyStorageAdapter', async () => {
    await verifyStorageAdapter(new MemoryStorage());
    const map = new Map<string, string>();
    const stringly: StorageAdapter = {
      get: async (key) => map.get(key) ?? null, // forgot JSON.parse
      set: async (key, value) => void map.set(key, JSON.stringify(value)),
      delete: async (key) => void map.delete(key),
    };
    expect(verifyStorageAdapter(stringly)).rejects.toThrow(/equal object/);
  });

  test('example SqliteStorage passes verifyStorageAdapter', async () => {
    const { SqliteStorage } = await import('../examples/storage/sqlite');
    const storage = new SqliteStorage(':memory:');
    await verifyStorageAdapter(storage);
    storage.close();
  });

  test('MemoryStorage clones values', async () => {
    const storage = new MemoryStorage();
    const value = { a: [1] };
    await storage.set('k', value);
    value.a.push(2);
    expect(await storage.get<object>('k')).toEqual({ a: [1] });
  });
});

describe('sendTo', () => {
  test('renders a page without an update, with the recipient session', async () => {
    const { app, bot, find, press, message } = setup();
    let info: unknown;
    const notify = page<{ id: string }>('notify').render(({ params, session, ctx, nav }) => {
        info = { proactive: isProactive(ctx), chat: ctx.chat?.id, from: ctx.from?.id, name: session.get('name') };
        return { text: `Order ${params.id} shipped`, keyboard: [[nav.self('Details', { x: 'y'.repeat(60) })]] };
      });
    app.register(notify);
    bot.command('name', async (ctx) => (await app.session(ctx)).set('name', 'Ann'));
    await message('/name', { userId: 42 });

    await app.sendTo(bot, 42, notify, { id: '7' });
    const sent = find('sendMessage').at(-1)!.payload;
    expect(sent).toMatchObject({ chat_id: 42, text: 'Order 7 shipped' });
    expect(sent.reply_parameters).toBeUndefined();
    expect(info).toEqual({ proactive: true, chat: 42, from: 42, name: 'Ann' });

    await press(buttons(sent)[0]!, { userId: 42 });
    expect(find('editMessageText').at(-1)!.payload.text).toBe('Order 7 shipped');
  });

  test('forum topics', async () => {
    const { app, bot, find } = setup();
    app.register(page('n').render(() => ({ text: 'hi' })));
    await app.sendTo(bot, { chatId: -100, userId: 3, threadId: 9 }, 'n');
    expect(find('sendMessage')[0]!.payload).toMatchObject({ chat_id: -100, message_thread_id: 9 });
  });
});

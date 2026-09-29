import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  EasyTG,
  MemoryStorage,
  SqliteStorage,
  dialogue,
  page,
  task,
  type EasyTGOptions,
  type StorageAdapter,
  type TaskStore,
} from '../src';
import { markdownToHtml } from '../src/format';
import { splitText } from '../src/split';
import { createTestBot, telegramError } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const buttons = () => t.calls.filter((c) => c.payload.reply_markup?.inline_keyboard).at(-1)!.payload.reply_markup.inline_keyboard.flat();
  const button = (label: string) => buttons().find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, buttons, button };
}

describe('delivery', () => {
  test("app.edit never deletes the message when the page doesn't fit in it", async () => {
    const { app, bot, methods } = setup();
    app.register(
      page('long').render(() => ({ text: 'word '.repeat(1000), parseMode: 'plain' })),
      page('album').render(() => ({ album: [{ type: 'photo', media: 'A' }, { type: 'photo', media: 'B' }] })),
    );
    expect(await app.edit(bot, { chatId: 7, messageId: 55 }, 'long')).toBeUndefined();
    expect(await app.edit(bot, { chatId: 7, messageId: 56 }, 'album')).toBeUndefined();
    expect(methods()).toEqual([]);
  });

  test('a keyboard-only page keeps the earlier parts of a long message', async () => {
    const { app, bot, message, press, button, sent, methods, reset } = setup();
    const kbOnly = page('kb').render(({ nav }) => ({ keyboard: [[nav.button('again', 'kb')]] }));
    const long = page('long').render(({ nav }) => ({ text: 'word '.repeat(1000), parseMode: 'plain', keyboard: [[nav.button('toggle', kbOnly)]] }));
    app.register(long, kbOnly);
    bot.command('go', (ctx) => app.open(ctx, long));
    await message('/go');
    const data = button('toggle');
    reset();
    await press(data, { messageId: sent.at(-1)!.message_id });
    expect(methods()).toEqual(['editMessageReplyMarkup', 'answerCallbackQuery']);
  });

  test('MarkdownV2 is never cut between a backslash and what it escapes; blank chunks are dropped', () => {
    for (const chunk of splitText('xx' + 'a\\.'.repeat(2000), false, [4096], true)) {
      expect(chunk.match(/\\*$/)![0].length % 2).toBe(0);
    }
    expect(splitText('aaaa' + ' '.repeat(40) + 'bbbb', false, [10])).toEqual(['aaaa      ', 'bbbb']);
  });

  test('code keeps its backslashes; fences accept languages like c++', () => {
    expect(markdownToHtml('`\\d+\\.x`')).toBe('<code>\\d+\\.x</code>');
    expect(markdownToHtml('```c#\n**x**\n```')).toBe('<pre><code class="language-c#">**x**</code></pre>');
  });
});

describe('sessions and navigation', () => {
  test('sendTo from a handler of the same user shares its session', async () => {
    const { app, bot, message, find, reset } = setup();
    const search = page('search')
      .render(() => ({ text: 'type' }))
      .onText(({ text }) => ({ text: `got ${text}`, parseMode: 'plain' }));
    app.register(search);
    bot.command('go', async (ctx) => {
      (await app.session(ctx)).set('x', 1);
      await app.sendTo(bot, ctx.chat.id, search);
    });
    let x: unknown;
    bot.command('x', async (ctx) => void (x = (await app.session(ctx)).get('x')));
    await message('/go');
    reset();
    await message('hello');
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['got hello']);
    await message('/x');
    expect(x).toBe(1);
  });

  for (const params of ['stored', 'signed', 'auto'] as const) {
    test(`an allowedUsers menu stays shared after a press (${params})`, async () => {
      const { app, bot, press, button, sent, find, reset } = setup({ buttons: { params, secret: 'x'.repeat(20) } });
      const card = page<{ n: string }>('card').render(({ params, nav }) => ({
        text: `card ${params.n}`,
        keyboard: [[nav.button('next', card, { n: String(Number(params.n) + 1) })]],
      }));
      app.register(card);
      await app.sendTo(bot, { chatId: -100, allowedUsers: [7, 8] }, card, { n: '1' });
      const messageId = sent.at(-1)!.message_id;
      await press(button('next'), { userId: 7, chatType: 'group', messageId });
      const next = button('next');
      reset();
      await press(next, { userId: 8, chatType: 'group', messageId });
      expect(find('editMessageText').map((c) => c.payload.text)).toEqual(['card 3']);
      const third = button('next');
      reset();
      await press(third, { userId: 9, chatType: 'group', messageId });
      expect(find('answerCallbackQuery')[0]!.payload.text).toBe(app.texts.notYourMenu);
    });
  }

  test("a dialogue's onFinish redirect is recorded like any page view", async () => {
    const { app, bot, message, find, reset } = setup();
    const views: string[] = [];
    app.on('pageView', ({ page }) => void views.push(page));
    const search = page('search')
      .render(() => ({ text: 'type', parseMode: 'plain' }))
      .onText(({ text }) => ({ text: `got ${text}`, parseMode: 'plain' }));
    const ask = dialogue<{ q: string }>('ask')
      .steps([{ id: 'q', type: 'text', text: 'q?' }])
      .onFinish(({ nav }) => nav.redirect(search));
    app.register(search, ask);
    bot.command('ask', (ctx) => app.startDialogue(ctx, ask));
    await message('/ask');
    await message('first');
    expect(views).toEqual(['search']);
    reset();
    await message('tea');
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['got tea']);
  });

  test('closing a page ends its text input', async () => {
    const { app, bot, message, press, button, sent } = setup();
    const search = page('search')
      .render(({ nav }) => ({ text: 'type', keyboard: [[nav.close()]] }))
      .onText(({ text }) => ({ text: `got ${text}` }));
    app.register(search);
    const seen: string[] = [];
    bot.command('search', (ctx) => app.open(ctx, search));
    bot.on('message:text', (ctx) => void seen.push(ctx.message.text));
    await message('/search');
    await press(button('Close'), { messageId: sent.at(-1)!.message_id });
    await message('hello');
    expect(seen).toEqual(['hello']);
  });

  test('params: false is dropped, and dialogue params are always strings', async () => {
    const { app, bot, message } = setup();
    let got: unknown;
    const d = dialogue<{ a: string }, { id: string; archived?: string }>('d')
      .steps(({ params }) => ((got = params), [{ id: 'a', type: 'text', text: 'a?' }]))
      .onFinish(() => undefined);
    const p = page('p').render(({ nav }) => nav.startDialogue(d, { id: 42 as never, archived: false as never }));
    app.register(d, p);
    bot.command('p', (ctx) => app.open(ctx, p));
    await message('/p');
    expect(got).toEqual({ id: '42' });
  });
});

describe('dialogues', () => {
  test('collect keeps its Done button after an error and starts over after a failed validation', async () => {
    const { app, bot, message, press, button, find, reset, sent } = setup();
    let answer: unknown;
    const d = dialogue<{ notes: { texts: string[] } }>('notes')
      .steps([{ id: 'notes', type: 'collect', accept: ['text'], text: 'Send notes', validate: (items) => items.texts.length <= 2 || 'max 2' }])
      .onFinish(({ answers }) => void (answer = answers.notes.texts));
    app.register(d);
    bot.command('go', (ctx) => app.startDialogue(ctx, d));
    await message('/go');
    await message('one');
    await message('', { extra: { text: undefined, sticker: { file_id: 'S', file_unique_id: 's' } } });
    const prompt = find('sendMessage').at(-1)!.payload;
    expect(prompt.text).toBe('Send notes');
    expect(prompt.reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text)).toContain(app.texts.done);

    await message('two');
    await message('three');
    const done = button(app.texts.done);
    reset();
    await press(done, { messageId: sent.at(-1)!.message_id });
    const after = find('sendMessage').at(-1)!.payload;
    expect(after.reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text)).not.toContain(app.texts.done);

    await message('four');
    await press(button(app.texts.done), { messageId: sent.at(-1)!.message_id });
    expect(answer).toEqual(['four']);
  });
});

describe('queues and limits', () => {
  test('a queue slot held by the update is not waited for again', async () => {
    const { app, bot, message } = setup({ queues: { ai: { concurrency: 1 } } });
    let done = false;
    bot.on('message', async (ctx) => {
      await app.enterQueue(ctx, 'ai');
      await app.enterQueue(ctx, 'ai');
      await app.queue('ai', () => app.queue('ai', () => undefined, { ctx }), { ctx });
      done = true;
    });
    await message('hi');
    expect(done).toBe(true);
    expect(await app.queue('ai', () => 'free')).toBe('free');
  });

  test('limitUser drops every update of the user, except payments', async () => {
    const { app, bot, message } = setup();
    let handled = 0;
    bot.on('message', () => void handled++);
    await app.limitUser(7, 60_000);
    await message('hi group', { chatType: 'group' });
    await message('hi', { extra: { edit_date: 2 } });
    expect(handled).toBe(0);
  });

  test('concurrent updates over the limit give one spam event', async () => {
    const storage = new MemoryStorage();
    const a = setup({ storage, cluster: true, antiSpam: { limit: 2, warn: false } });
    const b = setup({ storage, cluster: true, antiSpam: { limit: 2, warn: false } });
    let events = 0;
    for (const { app } of [a, b]) app.on('spam', () => void events++);
    await a.message('1');
    await b.message('2', { chatId: 50 });
    await Promise.all([a.message('3', { chatId: 51 }), b.message('4', { chatId: 52 }), a.message('5', { chatId: 53 })]);
    expect(events).toBe(1);
  });
});

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

describe('i18n', () => {
  test('pt_BR, PT-br and pt-br are the same language', () => {
    const app = new EasyTG({ logger: false, i18n: { messages: { pt_BR: { hi: 'Oi' }, en: { hi: 'Hi' } } } });
    expect(app.t('pt-br')('hi')).toBe('Oi');
    expect(app.t('PT_br')('hi')).toBe('Oi');
  });
});

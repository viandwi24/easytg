import { describe, expect, test } from 'bun:test';
import { InlineKeyboard } from 'grammy';
import { EasyTG, page, EasyTGError, MemoryStorage, md, type EasyTGOptions, type StorageAdapter } from '../src';
import { createTestBot, telegramError } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const home = page('home').render(() => ({ text: 'home' }));

describe('pages', () => {
  test('the same page is a reply for commands and an edit for buttons', async () => {
    const { app, bot, find, press, message, reset } = setup();
    const counter = page<{ n?: string }>('counter').render(({ params, nav }) => {
        const n = Number(params.n ?? 1);
        return {
          text: [md`Count **${n}**`, 'v1.0!'],
          keyboard: [[nav.self('+1', { n: n + 1 })]],
        };
      });
    app.register(counter);
    bot.command('start', (ctx) => app.open(ctx, counter));

    await message('/start');
    const [sent] = find('sendMessage');
    expect(sent!.payload).toMatchObject({ text: 'Count <b>1</b>\nv1.0!', parse_mode: 'HTML' });
    expect(sent!.payload.reply_parameters.allow_sending_without_reply).toBe(true);
    expect(sent!.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe('p|counter|n=2');

    reset();
    await press('p|counter|n=2');
    expect(find('editMessageText')[0]!.payload.text).toContain('<b>2</b>');
    expect(find('answerCallbackQuery')).toHaveLength(1);
    expect(find('sendMessage')).toHaveLength(0);
  });

  test('render args and typed navigation between pages', async () => {
    const { app, press, find } = setup();
    let seen: unknown;
    const detail = page<{ id: string; tab?: string }>('detail').render(({ params, page, ctx, app: a }) => {
        seen = { params, page: page.id, from: ctx.from?.id, same: a === app };
        return { text: 'detail' };
      });
    const list = page('list').render(({ nav }) => ({ text: 'list', keyboard: [[nav.button('Open', detail, { id: 42 })]] }));
    app.register(list, detail);

    await press('p|list');
    const data = find('editMessageText')[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data;
    await press(data);
    expect(seen).toEqual({ params: { id: '42' }, page: 'detail', from: 7, same: true });
  });

  test('middlewares: global first, can redirect', async () => {
    const order: string[] = [];
    const login = page('login').render(() => ({ text: 'please log in' }));
    const { app, bot, press, message, find } = setup({
      middlewares: [
        async ({ target, session, nav }, next) => {
          order.push('global');
          // global middlewares also run for redirect targets: let the login page through
          return target.id === 'login' || session.get('user') ? next() : nav.redirect(login);
        },
      ],
    });
    const secret = page('secret')
      .use(async (_args, next) => (order.push('page'), next()))
      .render(() => (order.push('render'), { text: 'secret' }));
    app.register(login, secret);
    bot.command('login', async (ctx) => (await app.session(ctx)).set('user', 'ann'));

    await press('p|secret');
    expect(find('editMessageText').at(-1)!.payload.text).toBe('please log in');
    expect(order).toEqual(['global', 'global']);

    await message('/login');
    await press('p|secret');
    expect(find('editMessageText').at(-1)!.payload.text).toBe('secret');
    expect(order).toEqual(['global', 'global', 'global', 'page', 'render']);
  });

  test('redirect loops are stopped', async () => {
    const errors: unknown[] = [];
    const { app, press } = setup();
    app.on('error', ({ error }) => void errors.push(error));
    const a = page('a').render(({ nav }) => nav.redirect('a'));
    app.register(a);
    await press('p|a');
    expect(String(errors[0])).toContain('Too many redirects');
  });

  test('toast, link preview and falsy keyboard entries', async () => {
    const { app, press, find } = setup();
    app.register(
      home,
      page('p').render(({ nav }) => ({
          text: 'https://example.com',
          toast: { text: 'Saved', alert: false },
          linkPreview: false,
          keyboard: [[false && nav.home(), nav.home()], false, [], [null]],
        })),
    );
    await press('p|p');
    expect(find('answerCallbackQuery')[0]!.payload).toMatchObject({ text: 'Saved' });
    const edit = find('editMessageText')[0]!.payload;
    expect(edit.link_preview_options).toEqual({ is_disabled: true });
    expect(edit.reply_markup.inline_keyboard).toEqual([[{ text: '🏠 Home', callback_data: 'p|home' }]]);
  });

  test('unknown / prototype ids answer "not found" once', async () => {
    const { app, press, find, reset } = setup();
    app.register(home);
    for (const id of ['nope', '__proto__', 'constructor', 'toString']) {
      reset();
      await press(`p|${id}`);
      expect(find('answerCallbackQuery')).toHaveLength(1);
      expect(find('answerCallbackQuery')[0]!.payload.show_alert).toBe(true);
    }
  });

  test('render errors show one alert', async () => {
    const errors: unknown[] = [];
    const { app, press, find } = setup();
    app.on('error', ({ error }) => void errors.push(error));
    app.register(page('boom').render(() => { throw new Error('db down'); }));
    await press('p|boom');
    expect(find('answerCallbackQuery')).toEqual([
      { method: 'answerCallbackQuery', payload: expect.objectContaining({ show_alert: true, text: app.texts.error }) },
    ]);
    expect(errors).toHaveLength(1);
  });

  test('"not modified" is ignored, unavailable messages fall back to send', async () => {
    const { app, press, find, responders } = setup();
    app.register(page('x').render(() => ({ text: 'x' })));
    responders.editMessageText = () => telegramError('Bad Request: message is not modified');
    await press('p|x');
    expect(find('sendMessage')).toHaveLength(0);
    responders.editMessageText = () => telegramError('Bad Request: message to edit not found');
    await press('p|x');
    expect(find('sendMessage')).toHaveLength(1);
  });

  test('keyboard-only content and InlineKeyboard instances', async () => {
    const { app, press, methods } = setup();
    app.register(page('kb').render(() => ({ keyboard: new InlineKeyboard().text('a', 'p|kb') })));
    await press('p|kb');
    expect(methods()).toEqual(['editMessageReplyMarkup', 'answerCallbackQuery']);
  });

  test('photo transitions', async () => {
    const { app, press, find, reset } = setup();
    app.register(
      page('pic').render(() => ({ text: 'cap', photo: 'FILE_A' })),
      page('txt').render(() => ({ text: 'plain' })),
    );
    await press('p|pic');
    expect(find('editMessageMedia')[0]!.payload.media).toMatchObject({ type: 'photo', media: 'FILE_A', caption: 'cap' });
    reset();
    await press('p|pic', { message: { text: undefined, photo: [{ file_id: 'FILE_A' }] } });
    expect(find('editMessageCaption')).toHaveLength(1);
    reset();
    await press('p|txt', { message: { text: undefined, photo: [{ file_id: 'FILE_A' }] } });
    expect(find('deleteMessage')).toHaveLength(1);
    expect(find('sendMessage')[0]!.payload.text).toBe('plain');
  });

  test('parse modes', async () => {
    const { app, press, find } = setup({ parseMode: 'html' });
    app.register(
      page('h').render(() => ({ text: '<b>x</b>' })),
      page('p').render(() => ({ text: '*x*', parseMode: 'plain' })),
    );
    await press('p|h');
    await press('p|p');
    const [h, p] = find('editMessageText');
    expect(h!.payload).toMatchObject({ text: '<b>x</b>', parse_mode: 'HTML' });
    expect(p!.payload.text).toBe('*x*');
    expect(p!.payload.parse_mode).toBeUndefined();
  });

  test('close button and foreign callback data', async () => {
    const { app, bot, press, methods, reset } = setup();
    app.register(home);
    let reached = false;
    bot.callbackQuery('other', () => void (reached = true));
    await press('other');
    expect(reached).toBe(true);
    expect(methods()).not.toContain('deleteMessage');
    reset();
    await press('p|exit');
    expect(methods()).toContain('deleteMessage');
  });

  test('registration and button errors are loud', async () => {
    const { app, press } = setup();
    app.on('error', () => {});
    expect(() => page('a|b').render(() => undefined)).toThrow(EasyTGError);
    expect(() => page('exit').render(() => undefined)).toThrow(EasyTGError);
    expect(() => page('_x').render(() => undefined)).toThrow(EasyTGError);
    app.register(home);
    expect(() => app.register(page('home').render(() => undefined))).toThrow(/already registered/);

    const orphan = page('orphan').render(() => undefined);
    let error: unknown;
    app.register(page('bad').render(({ nav }) => { try { nav.button('x', orphan); } catch (e) { error = e; } }));
    await press('p|bad');
    expect(String(error)).toContain('not a registered page');
  });
});

describe('sessions', () => {
  function counting(): StorageAdapter & { writes: number } {
    const inner = new MemoryStorage();
    const adapter = {
      writes: 0,
      get: (key: string) => inner.get(key),
      set: (key: string, value: unknown, ttl?: number) => ((adapter.writes += 1), inner.set(key, value, ttl)),
      delete: (key: string) => inner.delete(key),
    };
    return adapter;
  }

  test('changes are written once per update and persist across updates', async () => {
    const storage = counting();
    const { app, bot, message, find } = setup({ storage });
    const p = page('p').render(({ session }) => {
        session.set('a', (session.get<number>('a') ?? 0) + 1);
        session.set('b', 'x');
        session.setMany({ c: 1, d: 2 });
        return { text: `a=${session.get('a')}` };
      });
    app.register(p);
    bot.command('go', (ctx) => app.open(ctx, p));

    await message('/go');
    expect(storage.writes).toBe(1);
    await message('/go');
    expect(storage.writes).toBe(2);
    expect(find('sendMessage').map((c) => c.payload.text)).toEqual(['a=1', 'a=2']);
  });

  test('handlers after bot.use(app) get their session saved too', async () => {
    const { app, bot, message } = setup();
    bot.command('set', async (ctx) => (await app.session(ctx)).set('k', 'v'));
    let value: unknown;
    bot.command('get', async (ctx) => void (value = (await app.session(ctx)).get('k')));
    await message('/set');
    await message('/get');
    expect(value).toBe('v');
  });
});

describe('group menus', () => {
  test('only the user who opened a menu can use it', async () => {
    const { app, bot, press, message, find, sent, reset } = setup();
    const menu = page('menu').render(({ ctx }) => ({ text: `menu of ${ctx.from?.id}` }));
    app.register(menu);
    bot.command('menu', (ctx) => app.open(ctx, menu));

    await message('/menu', { userId: 1, chatType: 'group' });
    const messageId = sent.at(-1)!.message_id;

    reset();
    await press('p|menu', { userId: 2, chatType: 'group', messageId });
    expect(find('editMessageText')).toHaveLength(0);
    expect(find('answerCallbackQuery')[0]!.payload.text).toBe(app.texts.notYourMenu);

    reset();
    await press('p|menu', { userId: 1, chatType: 'group', messageId });
    expect(find('editMessageText')).toHaveLength(1);
  });
});

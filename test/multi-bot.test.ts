// Several bots sharing one storage: keys, deep links, per-bot state.
import { describe, expect, test } from 'bun:test';
import { EasyTG, MemoryStorage, page, type EasyTGOptions } from '../src';
import { createTestBot, type TestBotOptions } from '../src/testing';

function setup(options: EasyTGOptions = {}, bot: TestBotOptions = {}) {
  const t = createTestBot(bot);
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const errors: unknown[] = [];
  app.on('error', ({ error }) => void errors.push(error));
  return { ...t, app, errors };
}

const buttons = (payload: any): string[] => payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

describe('2. storage keys per bot', () => {
  function twoBots(options: EasyTGOptions = {}) {
    const storage = new MemoryStorage();
    const make = (id: number) => {
      const t = setup({ storage, ...options }, { botInfo: { id, username: `bot${id}` } });
      t.bot.command('set', async (ctx) => (await t.app.session(ctx)).set('v', `from bot ${id}`));
      let seen: unknown;
      t.bot.command('get', async (ctx) => void (seen = (await t.app.session(ctx)).get('v')));
      return { ...t, seen: () => seen };
    };
    return [make(1), make(2)] as const;
  }

  test('sessions of two bots sharing a storage stay apart', async () => {
    const [a, b] = twoBots();
    await a.message('/set');
    await b.message('/get');
    expect(b.seen()).toBeUndefined();
    await a.message('/get');
    expect(a.seen()).toBe('from bot 1');
  });

  test('scopeKeysByBot: false shares them (0.1 key format)', async () => {
    const [a, b] = twoBots({ scopeKeysByBot: false });
    await a.message('/set');
    await b.message('/get');
    expect(b.seen()).toBe('from bot 1');
  });

  test('stored deep links work across bots', async () => {
    const storage = new MemoryStorage();
    const promo = page<{ code: string }>('promo').allowDeepLink().render(({ params }) => ({ text: `promo ${params.code}` }));
    const make = (id: number) => {
      const t = setup({ storage }, { botInfo: { id, username: `bot${id}` } });
      t.app.register(promo);
      return t;
    };
    const [a, b] = [make(1), make(2)];
    const url = await a.app.deepLink(a.bot, promo, { code: 'x'.repeat(80) });
    await b.message(`/start ${new URL(url).searchParams.get('start')}`);
    expect(b.find('sendMessage')[0]!.payload.text).toBe(`promo ${'x'.repeat(80)}`);
  });
});

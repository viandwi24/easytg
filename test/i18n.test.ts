// Languages: setLocale, the last language seen, locale names.
import { describe, expect, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const buttons = () => t.calls.filter((c) => c.payload.reply_markup?.inline_keyboard).at(-1)!.payload.reply_markup.inline_keyboard.flat();
  const button = (label: string) => buttons().find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, buttons, button };
}

describe('languages', () => {
  const messages = { en: { saved: 'Saved', hi: 'Hi' }, id: { saved: 'Disimpan', hi: 'Halo' } };

  test('setLocale applies at once and to later sends', async () => {
    const { app, bot, message, find, reset } = setup({ i18n: { messages } });
    const picker = page<{ set?: string }>('lang').render(async ({ ctx, params, t }) => {
      if (params.set) await app.setLocale(ctx, params.set);
      return { text: t('saved'), parseMode: 'plain' };
    });
    const hello = page('hello').render(({ t }) => ({ text: t('hi'), parseMode: 'plain' }));
    app.register(picker, hello);
    bot.command('id', (ctx) => app.open(ctx, picker, { set: 'id' }));
    await message('/id', { language: 'en' });
    expect(find('sendMessage')[0]!.payload.text).toBe('Disimpan');
    reset();
    await app.sendTo(bot, { chatId: 7, userId: 7 }, hello);
    expect(find('sendMessage')[0]!.payload.text).toBe('Halo');
  });

  test('messages sent later use the language the user last wrote in', async () => {
    const { app, bot, message, find, reset } = setup({ i18n: { messages } });
    const hello = page('hello').render(({ t }) => ({ text: t('hi'), parseMode: 'plain' }));
    app.register(hello);
    bot.on('message', () => undefined);
    await message('hai', { language: 'id' });
    reset();
    await app.sendTo(bot, { chatId: 7, userId: 7 }, hello);
    expect(find('sendMessage')[0]!.payload.text).toBe('Halo');
  });
});

describe('i18n', () => {
  test('pt_BR, PT-br and pt-br are the same language', () => {
    const app = new EasyTG({ logger: false, i18n: { messages: { pt_BR: { hi: 'Oi' }, en: { hi: 'Hi' } } } });
    expect(app.t('pt-br')('hi')).toBe('Oi');
    expect(app.t('PT_br')('hi')).toBe('Oi');
  });
});

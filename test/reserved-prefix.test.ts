// buttons.reservedPrefix: which param names belong to easytg.
import { describe, expect, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const errors: unknown[] = [];
  app.on('error', ({ error }) => void errors.push(error));
  return { ...t, app, errors };
}

const buttons = (payload: any): string[] => payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);

describe('buttons.reservedPrefix', () => {
  test('by default names starting with "_" are refused', async () => {
    const t = setup();
    t.app.register(page('list').render(({ nav }) => ({ text: 'list', keyboard: [[nav.button('Next', 'list', { _pc: 2 })]] })));
    await t.press('p|list');
    expect(String(t.errors[0])).toContain('names starting with "_" are reserved');
  });

  test('with another prefix, "_" names are yours and the mode and signature params use the new prefix', async () => {
    const t = setup({ buttons: { reservedPrefix: '~', params: 'signed', secret: 'a-secret-of-16-chars' } });
    let seen: unknown;
    const list = page<{ _pc?: string }>('list').render(({ params, nav }) => {
      seen = params;
      return { text: 'list', keyboard: [[nav.button('Next', list, { _pc: 2 }), nav.button('New', list, {}, { mode: 'send' })]] };
    });
    t.app.register(list);
    await t.press('p|list');
    const [next, fresh] = buttons(t.find('editMessageText')[0]!.payload);
    expect(next).toStartWith('p|list|_pc=2&%7Es=');
    expect(fresh).toStartWith('p|list|%7Em=s&%7Es=');

    await t.press(next!);
    expect(seen).toEqual({ _pc: '2' });
    t.reset();
    await t.press(fresh!);
    expect(t.find('sendMessage')).toHaveLength(1); // { mode: 'send' } still works
    expect(t.errors).toEqual([]);
  });

  test('the new prefix is refused for your names', async () => {
    const t = setup({ buttons: { reservedPrefix: '~' } });
    t.app.register(page('list').render(({ nav }) => ({ text: 'list', keyboard: [[nav.button('Next', 'list', { '~x': 1 })]] })));
    await t.press('p|list');
    expect(String(t.errors[0])).toContain('names starting with "~" are reserved');
  });

  test('an unusable prefix fails at startup', () => {
    expect(() => new EasyTG({ buttons: { reservedPrefix: '' } })).toThrow('reservedPrefix');
    expect(() => new EasyTG({ buttons: { reservedPrefix: 'a|' } })).toThrow('reservedPrefix');
  });
});

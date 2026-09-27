import { expect, test } from 'bun:test';
import { EasyTG, page, paginate } from '../src';
import { createTestBot } from '../src/testing';

function setup() {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 } });
  t.bot.use(app);

  const home = page('home').render(({ nav }) => ({ text: 'home', keyboard: [[nav.back(), nav.button('List', list)]] }));
  const list = page('list').render((args) => {
    const { buttons } = paginate(args, { total: 30, perPage: 10 });
    return {
      text: `list ${args.params.page ?? 1}`,
      keyboard: [[args.nav.button('Item 7', detail, { id: '7' })], buttons, [args.nav.back()]],
    };
  });
  const detail = page<{ id: string }>('detail').render(({ params, nav }) => ({
    text: `detail ${params.id}`,
    keyboard: [[nav.button('Photo', photo)], [nav.back()]],
  }));
  const photo = page('photo').render(({ nav }) => ({ photo: 'FILE', text: 'a photo', keyboard: [[nav.back()]] }));
  app.register(home, list, detail, photo);
  t.bot.command('start', (ctx) => app.open(ctx, home));

  const menuId = () => t.sent[0]!.message_id;
  const shown = () => {
    const last = t.calls.filter((c) => /^(send|edit)Message(Text|Media|Caption)?$|^sendMessage$/.test(c.method)).at(-1)!.payload;
    return { text: last.text ?? last.caption ?? last.media?.caption, buttons: last.reply_markup.inline_keyboard.flat() as any[] };
  };
  /** Press the button labelled `label` in the last shown menu. */
  const tap = async (label: string, messageId = menuId()) => {
    const button = shown().buttons.find((b) => b.text.includes(label));
    if (!button) throw new Error(`no "${label}" button in: ${shown().buttons.map((b) => b.text)}`);
    await t.press(button.callback_data, { messageId });
  };
  return { ...t, app, shown, tap, menuId };
}

test('back walks the path the user took, and is hidden where there is nothing to go back to', async () => {
  const t = setup();
  await t.message('/start');
  expect(t.shown().buttons.map((b) => b.text)).toEqual(['List']); // fresh message: no Back

  await t.tap('List');
  await t.tap('➡️'); // page 2: same page, not a new step
  await t.tap('➡️'); // page 3
  await t.tap('Item 7');
  expect(t.shown().text).toBe('detail 7');

  await t.tap('Back');
  expect(t.shown().text).toBe('list 3'); // back to the list, with its params
  await t.tap('Back');
  expect(t.shown().text).toBe('home');
  expect(t.shown().buttons.map((b) => b.text)).toEqual(['List']);
});

test('history follows the menu when it is replaced by a new message', async () => {
  const t = setup();
  await t.message('/start');
  await t.tap('List');
  await t.tap('Item 7');
  await t.tap('Photo'); // text -> photo: edited in place here, same message id
  expect(t.shown().text).toBe('a photo');
  t.responders.editMessageText = () => new Error('Bad Request: there is no text in the message to edit');
  await t.tap('Back', t.menuId()); // photo -> text is replaced by a new message
  expect(t.shown().text).toBe('detail 7');
  const newId = t.sent.at(-1)!.message_id;
  delete t.responders.editMessageText;
  await t.tap('Back', newId); // the new message kept the history
  expect(t.shown().text).toBe('list 1');
});

test('a back press without history opens the home page', async () => {
  const t = setup();
  await t.press('p|_bk', { messageId: 12345 });
  expect(t.find('editMessageText')[0]!.payload.text).toBe('home');
});

test('each menu message has its own history', async () => {
  const t = setup();
  await t.message('/start'); // menu A
  await t.tap('List');
  await t.message('/start'); // menu B
  const menuB = t.sent.at(-1)!.message_id;
  await t.tap('List', menuB);
  await t.tap('Item 7', menuB);
  await t.tap('Back', menuB);
  expect(t.shown().text).toBe('list 1');
  await t.tap('Back', t.menuId()); // menu A: list -> home
  expect(t.shown().text).toBe('home');
});

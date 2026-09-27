import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, page, replyMenu, type DialogueContact, type DialogueLocation, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const lastMarkup = (t: ReturnType<typeof setup>) => t.find('sendMessage').at(-1)!.payload.reply_markup;
const labels = (markup: any) => markup.keyboard.map((row: any[]) => row.map((b) => b.text));

describe('main menu', () => {
  function setupMenu() {
    const products = page('products').render(() => ({ text: 'Products page' }));
    const orders = page('orders').render(() => ({ text: 'Orders page' }));
    const feedback = dialogue('feedback').steps([{ id: 'msg', type: 'text', text: 'Your feedback?' }]).onFinish(() => ({ text: 'thanks' }));
    const menu = replyMenu(
      [
        [replyMenu.button('🛍 Products', products), replyMenu.button((l) => (l === 'id' ? '🧾 Pesanan' : '🧾 Orders'), orders)],
        [replyMenu.button('💬 Feedback', feedback)],
      ],
      { placeholder: 'Choose…' },
    );
    const t = setup({ menu });
    t.app.register(products, orders, feedback);
    t.bot.command('start', (ctx) => t.app.showMenu(ctx, 'Welcome!'));
    let other = 0;
    t.bot.on('message:text', () => void other++);
    return { ...t, other: () => other };
  }

  test('showMenu sends the reply keyboard; buttons open pages as new messages', async () => {
    const t = setupMenu();
    await t.message('/start');
    const markup = lastMarkup(t);
    expect(labels(markup)).toEqual([['🛍 Products', '🧾 Orders'], ['💬 Feedback']]);
    expect(markup).toMatchObject({ resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Choose…' });

    await t.message('🛍 Products');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Products page');
    expect(t.find('sendMessage').at(-1)!.payload.reply_parameters).toBeUndefined();

    await t.message('💬 Feedback');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Your feedback?');

    await t.message('🛍 Products'); // leaves the dialogue, like a command
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Products page');
    await t.message('great bot');
    expect(t.other()).toBe(1); // no dialogue anymore, reaches the app's handlers
  });

  test('labels follow the user language', async () => {
    const t = setupMenu();
    await t.message('/start', { language: 'id' });
    expect(labels(lastMarkup(t))[0]).toEqual(['🛍 Products', '🧾 Pesanan']);
    await t.message('🧾 Pesanan', { language: 'id' });
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Orders page');
  });

  test('showMenu without a menu is a clear error', async () => {
    const t = setup();
    await expect(t.app.showMenu({} as any, 'x')).rejects.toThrow(/No menu configured/);
  });
});

describe('reply-keyboard steps', () => {
  function setupRegister(options: EasyTGOptions = {}) {
    let result: { phone?: DialogueContact; where?: DialogueLocation; size?: string } | undefined;
    const home = page('home').render(() => ({ text: 'home' }));
    const register = dialogue<{ size: string; phone: DialogueContact; where: DialogueLocation }>('register')
      .steps([
        { id: 'size', type: 'choice', reply: true, columns: 3, text: 'Size?', options: ['S', 'M', 'L'].map((s) => ({ text: s, value: s.toLowerCase() })) },
        { id: 'phone', type: 'contact', text: 'Your phone?' },
        { id: 'where', type: 'location', text: 'Where?', button: '📍 Here' },
        { id: 'note', type: 'text', text: 'Any note?' },
      ])
      .onFinish(({ answers }) => ((result = answers), { text: 'done' }));
    const t = setup(options);
    t.app.register(home, register);
    t.bot.command('go', (ctx) => t.app.startDialogue(ctx, register));
    return { ...t, result: () => result };
  }
  const contact = (userId: number) => ({ extra: { text: undefined, contact: { phone_number: '+62812', first_name: 'Ann', user_id: userId } } });

  test('choice, contact and location on the reply keyboard, then back to inline', async () => {
    const t = setupRegister();
    await t.message('/go');
    expect(labels(lastMarkup(t))).toEqual([['S', 'M', 'L'], ['❌ Cancel']]);

    t.reset();
    await t.message('XL'); // not an option
    expect(t.find('sendMessage').map((c) => c.payload.text)).toEqual([t.app.texts.expectChoice, 'Size?']);

    await t.message('M');
    const phoneMarkup = lastMarkup(t);
    expect(phoneMarkup.keyboard[0][0]).toEqual({ text: '📱 Share my contact', request_contact: true });
    expect(labels(phoneMarkup)[1]).toEqual(['⬅️ Back', '❌ Cancel']);

    t.reset();
    await t.message('+62 812 typed by hand');
    expect(t.find('sendMessage')[0]!.payload.text).toBe(t.app.texts.expectContact);
    t.reset();
    await t.message('', contact(999)); // someone else's contact
    expect(t.find('sendMessage')[0]!.payload.text).toBe(t.app.texts.contactNotYours);

    await t.message('', contact(7));
    expect(lastMarkup(t).keyboard[0][0]).toEqual({ text: '📍 Here', request_location: true });

    t.reset();
    await t.message('', { extra: { text: undefined, location: { latitude: -6.2, longitude: 106.8 } } });
    // leaving the reply keyboard: a short message removes the buttons, then the inline prompt
    const [restore, prompt] = t.find('sendMessage').map((c) => c.payload);
    expect(restore).toMatchObject({ text: t.app.texts.received, reply_markup: { remove_keyboard: true } });
    expect(prompt!.text).toBe('Any note?');
    expect(prompt!.reply_markup.inline_keyboard).toBeDefined();

    await t.message('ring twice');
    expect(t.result()).toEqual({
      size: 'm',
      phone: { phoneNumber: '+62812', firstName: 'Ann', userId: 7, lastName: undefined, vcard: undefined },
      where: { latitude: -6.2, longitude: 106.8, horizontalAccuracy: undefined },
      note: 'ring twice',
    } as any);
  });

  test('Back and Cancel are reply buttons on these steps; cancel restores the menu', async () => {
    const menuHome = page('menu-home').render(() => ({ text: 'h' }));
    const t = setupRegister({ menu: replyMenu([[replyMenu.button('🏠 Home', menuHome)]]) });
    t.app.register(menuHome);
    await t.message('/go');
    await t.message('S');
    await t.message('⬅️ Back');
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Size?');

    t.reset();
    await t.message('❌ Cancel');
    const restore = t.find('sendMessage')[0]!.payload;
    expect(restore.text).toBe(t.app.texts.cancelled);
    expect(labels(restore.reply_markup)).toEqual([['🏠 Home']]);
    t.reset();
    await t.message('S'); // dialogue is over
    expect(t.find('sendMessage')).toHaveLength(0);
  });

  test('service messages still pass through', async () => {
    const t = setupRegister();
    let paid = 0;
    t.bot.on('message:successful_payment', () => void paid++);
    await t.message('/go');
    await t.message('S');
    await t.message('', { extra: { text: undefined, successful_payment: { currency: 'USD', total_amount: 1, invoice_payload: 'x' } } });
    expect(paid).toBe(1);
  });

  test('actions are rejected on reply-keyboard steps', async () => {
    const t = setup();
    const errors: unknown[] = [];
    t.app.on('error', ({ error }) => void errors.push(error));
    const d = dialogue('d')
      .steps([{ id: 'p', type: 'contact', text: 'Phone?', actions: [{ id: 'x', text: 'X', run: () => undefined }] }])
      .onFinish(() => undefined);
    t.app.register(d, page('launch').render(({ nav }) => nav.startDialogue(d)));
    await t.press('p|launch');
    expect(String(errors[0])).toContain("can't have actions");
  });
});

describe('closing the menu', () => {
  test('replyMenu.close() removes the menu, in the user language, and leaves dialogues', async () => {
    const home = page('home2').render(() => ({ text: 'home' }));
    const survey = dialogue('survey2').steps([{ id: 'q', type: 'text', text: 'Q?' }]).onFinish(() => undefined);
    const t = setup({
      menu: replyMenu([[replyMenu.button('🏠 Home', home), replyMenu.button('📝 Survey', survey)], [replyMenu.close()]]),
      i18n: { locales: { id: { closeMenu: '✖️ Tutup menu', menuClosed: 'Menu ditutup.' } } },
    });
    t.app.register(home, survey);
    t.bot.command('start', (ctx) => t.app.showMenu(ctx, 'Welcome'));

    await t.message('/start');
    expect(labels(lastMarkup(t))).toEqual([['🏠 Home', '📝 Survey'], ['✖️ Close menu']]);

    await t.message('📝 Survey');
    t.reset();
    await t.message('✖️ Close menu');
    expect(t.find('sendMessage')).toEqual([
      { method: 'sendMessage', payload: expect.objectContaining({ text: 'Menu closed.', reply_markup: { remove_keyboard: true } }) },
    ]);
    t.reset();
    await t.message('answer'); // the dialogue was left
    expect(t.find('sendMessage')).toHaveLength(0);

    await t.message('/start', { language: 'id' });
    expect(labels(lastMarkup(t))[1]).toEqual(['✖️ Tutup menu']);
    await t.message('✖️ Tutup menu', { language: 'id' });
    expect(t.find('sendMessage').at(-1)!.payload.text).toBe('Menu ditutup.');
  });

  test('custom label', async () => {
    const t = setup({ menu: replyMenu([[replyMenu.close('Hide keyboard')]]) });
    t.bot.command('start', (ctx) => t.app.showMenu(ctx, 'Welcome'));
    await t.message('/start');
    expect(labels(lastMarkup(t))).toEqual([['Hide keyboard']]);
    await t.message('Hide keyboard');
    expect(t.find('sendMessage').at(-1)!.payload.reply_markup).toEqual({ remove_keyboard: true });
  });
});

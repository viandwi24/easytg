import { describe, expect, test } from 'bun:test';
import { GrammyError } from 'grammy';
import { EasyTG, dialogue, md, page, replyMenu, type EasyTGOptions } from '../src';
import { TelegramSimulator, parseHtml, parseMarkdownV2 } from '../src/simulator';

function setup(options: EasyTGOptions = {}) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0 } });
  bot.use(app);
  return { sim, bot, app };
}

const buttons = (sim: TelegramSimulator) =>
  (sim.last()!.message.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text);

describe('simulator with easytg', () => {
  test('pages: send, press, edit in place', async () => {
    const { sim, bot, app } = setup();
    const detail = page<{ id: string }>('detail').render(({ params, nav }) => ({ text: md`Item **${params.id}**`, keyboard: [[nav.back()]] }));
    const home = page('home').render(({ nav }) => ({ text: 'Home', keyboard: [[nav.button('Open A', detail, { id: 'A' })]] }));
    app.register(home, detail);
    bot.command('start', (ctx) => app.open(ctx, home));

    await sim.send('/start');
    expect(sim.messages().map((m) => m.message.text)).toEqual(['/start', 'Home']);
    expect(sim.messages()[0]!.message.entities).toEqual([{ type: 'bot_command', offset: 0, length: 6 }]);
    const menu = sim.last()!;
    await sim.press(menu.message.message_id, 'Open A');
    expect(sim.messages()).toHaveLength(2); // edited, not sent
    expect(sim.last()!.message.text).toBe('Item A');
    expect(sim.last()!.message.entities).toEqual([{ type: 'bold', offset: 5, length: 1 }]);
    expect(sim.last()!.message.edit_date).toBeDefined();
    await sim.press(menu.message.message_id, [0, 0]);
    expect(sim.last()!.message.text).toBe('Home');
    expect(buttons(sim)).toEqual(['Open A']);
  });

  test('dialogues with text answers and a toast', async () => {
    const { sim, bot, app } = setup();
    const form = dialogue('form')
      .steps([
        { id: 'name', type: 'text', text: 'Your name?' },
        { id: 'ok', type: 'choice', text: 'Sure?', options: [{ text: 'Yes', value: 'y' }] },
      ])
      .onFinish(({ answers }) => ({ text: `Hi ${answers.name}` }));
    app.register(form);
    bot.command('start', (ctx) => app.startDialogue(ctx, form));
    await sim.send('/start');
    expect(sim.last()!.message.text).toBe('Your name?');
    await sim.send('Ann');
    const confirm = sim.last()!;
    expect(confirm.message.text).toBe('Sure?');
    await sim.press(confirm.message.message_id, 'Yes');
    expect(sim.messages().some((m) => m.message.text === 'Hi Ann')).toBe(true);
  });

  test('reply keyboard: shown, pressed, removed', async () => {
    const orders = page('orders').render(() => ({ text: 'Your orders' }));
    const menu = replyMenu([[replyMenu.button('🧾 Orders', orders)], [replyMenu.close()]]);
    const { sim, bot, app } = setup({ menu });
    app.register(orders);
    bot.command('start', (ctx) => app.showMenu(ctx, 'Menu'));
    await sim.send('/start');
    const keyboard = sim.chat(sim.user.id)!.replyKeyboard!;
    expect(keyboard.keyboard.flat().map((b) => (typeof b === 'string' ? b : b.text))).toEqual(['🧾 Orders', '✖️ Close menu']);
    await sim.pressReply(keyboard.keyboard[0]![0]!);
    expect(sim.last()!.message.text).toBe('Your orders');
    await sim.pressReply(keyboard.keyboard[1]![0]!);
    expect(sim.chat(sim.user.id)!.replyKeyboard).toBeNull();
  });

  test('toasts and alerts', async () => {
    const { sim, bot } = setup();
    bot.command('start', (ctx) => ctx.reply('x', { reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] } }));
    bot.callbackQuery('go', (ctx) => ctx.answerCallbackQuery({ text: 'Done!', show_alert: true }));
    const toasts: string[] = [];
    sim.on('toast', (t) => toasts.push(`${t.text}:${t.alert}`));
    await sim.send('/start');
    expect(await sim.press(sim.last()!.message.message_id, 'go')).toEqual({ text: 'Done!', alert: true, url: undefined });
    expect(toasts).toEqual(['Done!:true']);
  });

  test('payments: invoice, pre-checkout, successful_payment', async () => {
    const paid: string[] = [];
    const { sim, bot, app } = setup({
      payments: {
        preCheckout: () => true,
        onSuccess: ({ payment }) => {
          paid.push(payment.invoice_payload);
          return { text: 'Thanks!' };
        },
      },
    });
    const product = page('product').render(({ nav }) => ({
      invoice: { title: 'Pack', description: 'Stickers', payload: 'pack', currency: 'XTR', prices: [{ label: 'Pack', amount: 2 }] },
      keyboard: [[nav.pay('Pay ⭐ 2')]],
    }));
    app.register(product);
    bot.command('start', (ctx) => app.open(ctx, product));
    await sim.send('/start');
    const invoice = sim.last()!;
    expect(invoice.message.invoice).toMatchObject({ title: 'Pack', currency: 'XTR', total_amount: 2 });
    expect(await sim.pay(invoice.message.message_id)).toEqual({ ok: true, error: undefined });
    expect(paid).toEqual(['pack']);
    expect(sim.last()!.message.text).toBe('Thanks!');
  });

  test('inline mode: results, choosing one, pressing its button', async () => {
    const { sim, bot } = setup();
    bot.on('inline_query', (ctx) =>
      ctx.answerInlineQuery([
        {
          type: 'article',
          id: '1',
          title: `Result for ${ctx.inlineQuery.query}`,
          input_message_content: { message_text: '<b>Shared</b>', parse_mode: 'HTML' },
          reply_markup: { inline_keyboard: [[{ text: 'Like', callback_data: 'like' }]] },
        },
      ]),
    );
    bot.callbackQuery('like', (ctx) => ctx.editMessageText('Liked'));
    const results = await sim.inlineQuery('cats');
    expect(results.map((r) => ('title' in r ? r.title : ''))).toEqual(['Result for cats']);
    const sent = await sim.chooseInlineResult(results[0]!, 'cats');
    expect(sent.message.via_bot?.username).toBe('demo_bot');
    expect(sent.message.entities).toEqual([{ type: 'bold', offset: 0, length: 6 }]);
    await sim.press(sent.message.message_id, 'Like', { inlineMessageId: sent.inlineMessageId });
    expect(sent.message.text).toBe('Liked');
  });

  test('bot.start() polls updates from the simulator', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    bot.on('message:text', async (ctx) => {
      await Bun.sleep(30);
      await ctx.reply(`echo ${ctx.message.text}`);
    });
    bot.on('inline_query', (ctx) => ctx.answerInlineQuery([{ type: 'article', id: '1', title: 'x', input_message_content: { message_text: 'x' } }]));
    void bot.start();
    await Bun.sleep(20);
    await sim.send('hi'); // resolves once grammY has handled it
    expect(sim.last()!.message.text).toBe('echo hi');
    expect(await sim.inlineQuery('q')).toHaveLength(1);
    await bot.stop();
  });
});

describe('Telegram errors', () => {
  test('bad HTML, not modified, missing messages, blocked users', async () => {
    const { sim, bot } = setup();
    await sim.send('hello');
    const api = bot.api;
    await expect(api.sendMessage(sim.user.id, '<b>open', { parse_mode: 'HTML' })).rejects.toThrow("can't parse entities");
    await expect(api.sendMessage(sim.user.id, 'a.b', { parse_mode: 'MarkdownV2' })).rejects.toThrow("Character '.' is reserved");
    const sent = await api.sendMessage(sim.user.id, 'same');
    await expect(api.editMessageText(sim.user.id, sent.message_id, 'same')).rejects.toThrow('message is not modified');
    await expect(api.editMessageText(sim.user.id, 999, 'x')).rejects.toThrow('message to edit not found');
    await expect(api.sendMessage(sim.user.id, 'x'.repeat(4097))).rejects.toThrow('message is too long');
    await expect(
      api.sendMessage(sim.user.id, 'x', { reply_markup: { inline_keyboard: [[{ text: 'b', callback_data: 'x'.repeat(65) }]] } }),
    ).rejects.toThrow('BUTTON_DATA_INVALID');

    const stranger = sim.addUser({ first_name: 'Stranger' });
    await expect(api.sendMessage(stranger.id, 'hi')).rejects.toThrow("bot can't initiate conversation");
    await sim.block();
    const error = await api.sendMessage(sim.user.id, 'hi').catch((e: GrammyError) => e);
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).error_code).toBe(403);
  });

  test('clearHistory empties the chat without telling the bot', async () => {
    const { sim, bot } = setup();
    bot.command('start', (ctx) => ctx.reply('Hi', { reply_markup: { keyboard: [[{ text: 'A' }]], resize_keyboard: true } }));
    await sim.send('/start');
    const calls = sim.calls.length;
    sim.clearHistory();
    expect(sim.messages()).toEqual([]);
    expect(sim.chat(sim.user.id)!.replyKeyboard).toBeNull();
    expect(sim.calls.length).toBe(calls);
    await sim.send('/start'); // ids go on, like in Telegram
    expect(sim.messages()[0]!.message.message_id).toBe(3);
  });

  test('an edit without reply_markup removes the keyboard', async () => {
    const { sim, bot } = setup();
    await sim.send('hello');
    const sent = await bot.api.sendMessage(sim.user.id, 'x', { reply_markup: { inline_keyboard: [[{ text: 'b', callback_data: 'b' }]] } });
    await bot.api.editMessageText(sim.user.id, sent.message_id, 'y');
    expect(sim.last()!.message.reply_markup).toBeUndefined();
  });
});

describe('formatting', () => {
  test('HTML', () => {
    expect(parseHtml('<b>bold <i>both</i></b> &lt;x&gt; &#39;q&#39; <a href="https://e.com">link</a>')).toEqual({
      text: "bold both <x> 'q' link",
      entities: [
        { type: 'italic', offset: 5, length: 4 },
        { type: 'bold', offset: 0, length: 9 },
        { type: 'text_link', offset: 18, length: 4, url: 'https://e.com' },
      ],
    } as never);
    expect(parseHtml('<pre><code class="language-ts">let x</code></pre>').entities).toEqual([{ type: 'pre', offset: 0, length: 5, language: 'ts' }] as never);
    expect(() => parseHtml('<div>x</div>')).toThrow('Unsupported start tag "div"');
  });

  test('MarkdownV2', () => {
    const { text, entities } = parseMarkdownV2('*bold* _it_ __u__ ~s~ ||sp|| `c\\`` [l](https://e.com) 1\\.5');
    expect(text).toBe('bold it u s sp c` l 1.5');
    expect(entities.map((e) => e.type)).toEqual(['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code', 'text_link']);
    expect(parseMarkdownV2('>quote\n>more\nafter').entities).toEqual([{ type: 'blockquote', offset: 0, length: 10 }] as never);
    expect(() => parseMarkdownV2('*open')).toThrow();
  });
});

test('a text message can be edited into a photo (Bot API 10), not the other way round', async () => {
  const { sim, bot, app } = setup();
  const photo = page('photo').render(({ nav }) => ({ photo: 'https://example.com/a.jpg', text: 'A photo', keyboard: [[nav.button('Text', text)]] }));
  const text = page('text').render(({ nav }) => ({ text: 'Just text', keyboard: [[nav.button('Photo', photo)]] }));
  app.register(photo, text);
  bot.command('start', (ctx) => app.open(ctx, text));
  await sim.send('/start');
  const id = sim.last()!.message.message_id;
  await sim.tap('Photo');
  expect(sim.last()!.message.message_id).toBe(id); // edited in place, not deleted and sent again
  expect(sim.last()!.message.text).toBeUndefined();
  expect(sim.last()!.message.caption).toBe('A photo');
  expect(sim.last()!.media).toMatchObject({ kind: 'photo', url: 'https://example.com/a.jpg' });
  await sim.tap('Text'); // media → text still can't be edited: a new message
  expect(sim.last()!.message.text).toBe('Just text');
  expect(sim.last()!.message.message_id).not.toBe(id);
  await expect(bot.api.editMessageCaption(sim.user.id, sim.last()!.message.message_id, { caption: 'x' })).rejects.toThrow('there is no caption in the message to edit');
});

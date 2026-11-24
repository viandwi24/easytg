import { describe, expect, test } from 'bun:test';
import { TelegramSimulator } from '../packages/simulator/src';

/** A simulator, its bot, and the default user's chat with the bot already started. */
async function setup() {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  await sim.send('hi');
  return { sim, bot, chat: sim.user.id };
}

describe('venues and live locations', () => {
  test('sendVenue sends a venue with its location; bad input fails like Telegram', async () => {
    const { sim, bot, chat } = await setup();
    const sent = await bot.api.sendVenue(chat, -6.2, 106.8, 'Office', 'Jl. Sudirman 1', { google_place_id: 'abc' });
    expect(sent.venue).toEqual({ location: { latitude: -6.2, longitude: 106.8 }, title: 'Office', address: 'Jl. Sudirman 1', google_place_id: 'abc' });
    expect(sent.location).toEqual({ latitude: -6.2, longitude: 106.8 });
    expect(sim.last()!.message.venue?.title).toBe('Office');
    await expect(bot.api.sendVenue(chat, 91, 0, 'x', 'y')).rejects.toThrow('wrong latitude');
    await expect(bot.api.sendVenue(chat, 0, 0, '', 'y')).rejects.toThrow('venue title is empty');
  });

  test('a live location can be edited until it is stopped; a plain one cannot', async () => {
    const { sim, bot, chat } = await setup();
    const live = await bot.api.sendLocation(chat, 1, 2, { live_period: 600 });
    expect(live.location.live_period).toBe(600);
    expect(sim.last()!.liveUntil).toBe(live.date + 600);

    const edited = await bot.api.editMessageLiveLocation(chat, live.message_id, 1.5, 2.5, { heading: 90 });
    expect(edited).toMatchObject({ location: { latitude: 1.5, longitude: 2.5, heading: 90, live_period: 600 } });
    expect((edited as { edit_date?: number }).edit_date).toBeNumber();
    await expect(bot.api.editMessageLiveLocation(chat, live.message_id, 1.5, 2.5, { heading: 90 })).rejects.toThrow('message is not modified');

    const stopped = await bot.api.stopMessageLiveLocation(chat, live.message_id);
    expect((stopped as { location: object }).location).toEqual({ latitude: 1.5, longitude: 2.5 });
    expect(sim.last()!.liveUntil).toBeUndefined();
    await expect(bot.api.stopMessageLiveLocation(chat, live.message_id)).rejects.toThrow("message can't be edited");
    await expect(bot.api.editMessageLiveLocation(chat, live.message_id, 3, 4)).rejects.toThrow("message can't be edited");

    const still = await bot.api.sendLocation(chat, 1, 2);
    expect(still.location.live_period).toBeUndefined();
    await expect(bot.api.editMessageLiveLocation(chat, still.message_id, 3, 4)).rejects.toThrow("message can't be edited");
    await expect(bot.api.sendLocation(chat, 1, 2, { live_period: 5 })).rejects.toThrow('LIVE_PERIOD_INVALID');
  });

  test('an expired live location cannot be edited', async () => {
    const { sim, bot, chat } = await setup();
    const live = await bot.api.sendLocation(chat, 1, 2, { live_period: 60 });
    sim.last()!.liveUntil = live.date - 1;
    await expect(bot.api.editMessageLiveLocation(chat, live.message_id, 3, 4)).rejects.toThrow("message can't be edited");
  });
});

describe('polls', () => {
  test('stopPoll closes the poll and returns it; twice fails', async () => {
    const { sim, bot, chat } = await setup();
    const sent = await bot.api.sendPoll(chat, 'Lunch?', ['Pizza', 'Sushi']);
    const poll = await bot.api.stopPoll(chat, sent.message_id);
    expect(poll).toMatchObject({ question: 'Lunch?', is_closed: true, options: [{ text: 'Pizza' }, { text: 'Sushi' }] });
    expect(sim.last()!.message.poll?.is_closed).toBe(true);
    await expect(bot.api.stopPoll(chat, sent.message_id)).rejects.toThrow('poll has already been closed');
    const text = await bot.api.sendMessage(chat, 'not a poll');
    await expect(bot.api.stopPoll(chat, text.message_id)).rejects.toThrow('message with poll to stop not found');
  });
});

describe('payments', () => {
  test('a flexible invoice asks the bot for shipping options; the chosen one is added to the total', async () => {
    const { sim, bot, chat } = await setup();
    const seen: Record<string, unknown> = {};
    bot.on('shipping_query', async (ctx) => {
      seen.address = ctx.shippingQuery.shipping_address.city;
      await ctx.answerShippingQuery(true, {
        shipping_options: [
          { id: 'post', title: 'Post', prices: [{ label: 'Post', amount: 300 }] },
          { id: 'courier', title: 'Courier', prices: [{ label: 'Courier', amount: 900 }] },
        ],
      });
    });
    bot.on('pre_checkout_query', async (ctx) => {
      seen.checkout = { total: ctx.preCheckoutQuery.total_amount, option: ctx.preCheckoutQuery.shipping_option_id, city: ctx.preCheckoutQuery.order_info?.shipping_address?.city };
      await ctx.answerPreCheckoutQuery(true);
    });
    const invoice = await bot.api.sendInvoice(chat, 'Mug', 'A mug', 'mug-1', 'USD', [{ label: 'Mug', amount: 1000 }], { provider_token: 'x', is_flexible: true, need_shipping_address: true });
    const result = await sim.pay(invoice.message_id, { shippingAddress: { city: 'Bandung' }, shippingOption: 'courier' });
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ address: 'Bandung', checkout: { total: 1900, option: 'courier', city: 'Bandung' } });
    expect(sim.last()!.message.successful_payment).toMatchObject({ total_amount: 1900, shipping_option_id: 'courier' });
  });

  test('a shipping query answered with an error fails the payment', async () => {
    const { sim, bot, chat } = await setup();
    bot.on('shipping_query', (ctx) => ctx.answerShippingQuery(false, { error_message: 'We do not ship there' }));
    const invoice = await bot.api.sendInvoice(chat, 'Mug', 'A mug', 'mug-1', 'USD', [{ label: 'Mug', amount: 1000 }], { is_flexible: true });
    expect(await sim.pay(invoice.message_id)).toEqual({ ok: false, error: 'We do not ship there' });
    await expect(bot.api.answerShippingQuery('nope', true)).rejects.toThrow('query is too old');
  });

  test('refundStarPayment refunds a Stars payment once', async () => {
    const { sim, bot, chat } = await setup();
    let refunded: unknown;
    bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
    bot.on('message:refunded_payment', (ctx) => void (refunded = ctx.message.refunded_payment.total_amount));
    const invoice = await bot.api.sendInvoice(chat, 'Pro', '30 days', 'pro', 'XTR', [{ label: 'Pro', amount: 50 }]);
    await sim.pay(invoice.message_id);
    const charge = sim.last()!.message.successful_payment!.telegram_payment_charge_id;
    await expect(bot.api.refundStarPayment(chat, 'unknown')).rejects.toThrow('CHARGE_NOT_FOUND');
    expect(await bot.api.refundStarPayment(chat, charge)).toBe(true);
    await Bun.sleep(0);
    expect(sim.last()!.message.refunded_payment).toMatchObject({ total_amount: 50, telegram_payment_charge_id: charge });
    expect(refunded).toBe(50);
    await expect(bot.api.refundStarPayment(chat, charge)).rejects.toThrow('CHARGE_ALREADY_REFUNDED');
  });

  test('createInvoiceLink returns a t.me/$ link and checks the invoice', async () => {
    const { bot } = await setup();
    const link = await bot.api.createInvoiceLink('Pro', '30 days', 'pro', '', 'XTR', [{ label: 'Pro', amount: 50 }]);
    expect(link).toMatch(/^https:\/\/t\.me\/\$\w+$/);
    await expect(bot.api.createInvoiceLink('Pro', '30 days', 'pro', '', 'XTR', [])).rejects.toThrow('Bad Request');
  });
});

describe('bot settings', () => {
  test('getMyName/Description/ShortDescription return what was set, per language', async () => {
    const { sim, bot } = await setup();
    expect(await bot.api.getMyName()).toEqual({ name: sim.botInfo.first_name });
    await bot.api.setMyName('Shop Bot');
    await bot.api.setMyName('Bot Toko', { language_code: 'id' });
    expect(await bot.api.getMyName()).toEqual({ name: 'Shop Bot' });
    expect(await bot.api.getMyName({ language_code: 'id' })).toEqual({ name: 'Bot Toko' });
    expect(await bot.api.getMyName({ language_code: 'de' })).toEqual({ name: 'Shop Bot' });

    expect(await bot.api.getMyDescription()).toEqual({ description: '' });
    await bot.api.setMyDescription('Buy things');
    expect(await bot.api.getMyDescription()).toEqual({ description: 'Buy things' });
    await bot.api.setMyDescription('');
    expect(await bot.api.getMyDescription()).toEqual({ description: '' });

    await bot.api.setMyShortDescription('Shop', { language_code: 'en' });
    expect(await bot.api.getMyShortDescription({ language_code: 'en' })).toEqual({ short_description: 'Shop' });
    await expect(bot.api.setMyShortDescription('x'.repeat(121))).rejects.toThrow('too long');
  });

  test('getMyDefaultAdministratorRights returns the rights set, for groups and channels apart', async () => {
    const { bot } = await setup();
    expect((await bot.api.getMyDefaultAdministratorRights()).can_delete_messages).toBe(false);
    await bot.api.setMyDefaultAdministratorRights({ rights: { can_delete_messages: true, can_pin_messages: true } as never });
    const groups = await bot.api.getMyDefaultAdministratorRights();
    expect(groups).toMatchObject({ can_delete_messages: true, can_pin_messages: true, can_change_info: false });
    expect((await bot.api.getMyDefaultAdministratorRights({ for_channels: true })).can_delete_messages).toBe(false);
  });
});

describe('reactions', () => {
  test('users react; the bot removes one reaction or all of a user', async () => {
    const sim = new TelegramSimulator();
    const bot = sim.createBot();
    const bob = sim.addUser({ first_name: 'Bob' });
    const group = sim.createGroup({ title: 'Team', members: [sim.user.id, bob.id] });
    const updates: unknown[] = [];
    bot.on('message_reaction', (ctx) => void updates.push(ctx.messageReaction.new_reaction));
    const a = await bot.api.sendMessage(group.id, 'one');
    const b = await bot.api.sendMessage(group.id, 'two');
    await sim.react(a.message_id, '👍', { chat: group.id, user: bob.id });
    await sim.react(b.message_id, '🔥', { chat: group.id, user: bob.id });
    await sim.react(a.message_id, '❤', { chat: group.id });
    expect(updates).toEqual([[{ type: 'emoji', emoji: '👍' }], [{ type: 'emoji', emoji: '🔥' }], [{ type: 'emoji', emoji: '❤' }]]);

    await bot.api.raw.deleteMessageReaction({ chat_id: group.id, message_id: a.message_id, user_id: bob.id });
    expect(sim.messages(group.id).find((m) => m.message.message_id === a.message_id)!.reactions).toEqual([{ user: sim.user.id, reaction: [{ type: 'emoji', emoji: '❤' }] }]);
    await bot.api.raw.deleteAllMessageReactions({ chat_id: group.id, user_id: sim.user.id });
    expect(sim.messages(group.id).flatMap((m) => m.reactions ?? []).map((r) => r.user)).toEqual([bob.id]);
  });

  test('removing reactions needs an admin bot, in a group', async () => {
    const { bot, chat } = await setup();
    await expect(bot.api.raw.deleteAllMessageReactions({ chat_id: chat, user_id: chat })).rejects.toThrow('only for groups and supergroups');
  });
});

describe('stickers and prepared buttons', () => {
  test('getStickerSet and getCustomEmojiStickers know the sets added with addStickerSet', async () => {
    const { sim, bot, chat } = await setup();
    await expect(bot.api.getStickerSet('nope')).rejects.toThrow('STICKERSET_INVALID');
    const set = sim.addStickerSet({ name: 'faces_by_demo_bot', title: 'Faces', emojis: ['🙂', '😎'] });
    const fetched = await bot.api.getStickerSet('faces_by_demo_bot');
    expect(fetched).toMatchObject({ name: 'faces_by_demo_bot', title: 'Faces', sticker_type: 'regular' });
    expect(fetched.stickers.map((s) => s.emoji)).toEqual(['🙂', '😎']);
    const sent = await bot.api.sendSticker(chat, set.stickers[0]!.file_id);
    expect(sent.sticker).toBeDefined();

    const emoji = sim.addStickerSet({ name: 'icons_by_demo_bot', type: 'custom_emoji', emojis: ['⭐'] });
    const id = emoji.stickers[0]!.custom_emoji_id!;
    expect(await bot.api.getCustomEmojiStickers([id, '123'])).toEqual([emoji.stickers[0]!]);
  });

  test('savePreparedKeyboardButton takes request_users / request_chat buttons only', async () => {
    const { bot, chat } = await setup();
    const prepared = await bot.api.savePreparedKeyboardButton(chat, { text: 'Pick', request_users: { request_id: 1 } });
    expect(prepared.id).toBeString();
    await expect(bot.api.savePreparedKeyboardButton(chat, { text: 'Plain' } as never)).rejects.toThrow('request_users');
    await expect(bot.api.savePreparedKeyboardButton(424242, { text: 'Pick', request_users: { request_id: 1 } })).rejects.toThrow('user not found');
  });
});

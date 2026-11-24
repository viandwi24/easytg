/**
 * A small shop: reply-keyboard main menu, a catalog as a list or as cards
 * (one product per photo, ⬅️ ➡️ edit the photo in place), Back buttons, a
 * photo album, and a checkout that asks for size, phone number and delivery
 * location.
 *
 *   BOT_TOKEN=123:abc bun run examples/shop.ts
 *
 * Commands: /start shows the menu; "✖️ Close menu" or /hide removes it.
 *
 * Shows: replyMenu + app.showMenu / hideMenu, nav.back(), paginate (a list, and
 * photo cards whose media is edited in place), photo & album content,
 * dialogue steps `choice` (reply keyboard), `contact`, `location`, and events.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page, paginate, replyMenu, type DialogueContact, type DialogueLocation } from '../src';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/shop.ts');
  process.exit(1);
}

// Any photo URL or Telegram file_id works here; these are placeholder images
// with the product's name, a color each.
const COLORS = ['2a9ef1', 'e17076', '7bc862', 'faa774', 'a695e7', '6ec9cb'];
const photo = (name: string, i: number) => `https://placehold.co/600x400/${COLORS[i % COLORS.length]}/ffffff/png?text=${encodeURIComponent(name)}`;
const products = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `T-shirt #${i + 1}`,
  price: 10 + i,
  photo: photo(`T-shirt #${i + 1}`, i),
}));

interface Order {
  product: string;
  size: string;
  phone: string;
  location: DialogueLocation;
}

// ---- catalog: a list or cards, pagination, photos, Back ----------------------

const PER_PAGE = 4;

// One page, two views. `view: 'cards'` shows one product per message, with its
// photo; ⬅️ ➡️ edit that message in place (the photo changes with
// editMessageMedia). The list keeps its own `page`, the cards their `item`, so
// switching views lands on the same products.
const catalog = page<{ page?: string; item?: string; view?: string }>('catalog').render((args) => {
  const { nav, params } = args;
  if (params.view === 'cards') {
    const { offset, page: item, buttons } = paginate(args, { total: products.length, perPage: 1, param: 'item' });
    const p = products[offset]!;
    return {
      photo: p.photo,
      text: [md`**${p.name}**`, `$${p.price}`, '', `${item} of ${products.length}`],
      keyboard: [
        [nav.button('🛒 Buy', checkout, { product: p.id })],
        buttons, // ⏮️ ⬅️ 2/12 ➡️ ⏭️: edits this photo message
        [nav.button('☰ List view', catalog, { page: Math.ceil(item / PER_PAGE) })],
      ],
    };
  }
  const { offset, limit, buttons } = paginate(args, { total: products.length, perPage: PER_PAGE });
  return {
    text: '**Catalog**\nPick a product:',
    keyboard: [
      ...products.slice(offset, offset + limit).map((p) => [nav.button(`${p.name} · $${p.price}`, product, { id: p.id })]),
      buttons, // ⬅️ 1/3 ➡️
      [nav.button('🃏 Card view', catalog, { view: 'cards', item: offset + 1 }), nav.button('🖼 Gallery', gallery)],
    ],
  };
});

// `nav.back()` returns to the exact catalog page the user came from (with its
// `page` param). It is hidden automatically when there is nothing to go back to.
const product = page<{ id: string }>('product').render(({ params, nav }) => {
  const item = products.find((p) => p.id === params.id);
  if (!item) return nav.redirect(catalog);
  return {
    photo: item.photo,
    text: [md`**${item.name}**`, `$${item.price}`],
    keyboard: [[nav.button('🛒 Buy', checkout, { product: item.id })], [nav.back()]],
  };
});

// Albums can't carry buttons: the text and keyboard follow in their own message.
const gallery = page('gallery').render(({ nav }) => ({
  album: products.slice(0, 4).map((p) => ({ type: 'photo' as const, media: p.photo })),
  text: 'Our bestsellers',
  keyboard: [[nav.back()]],
}));

// ---- checkout: reply-keyboard steps --------------------------------------------

const checkout = dialogue<{ size: string; phone: DialogueContact; where: DialogueLocation }, { product: string }>('checkout')
  .steps([
    {
      id: 'size',
      type: 'choice',
      reply: true, // options on the reply keyboard, like a quick-reply
      columns: 4,
      text: 'Which size?',
      options: ['S', 'M', 'L', 'XL'].map((s) => ({ text: s, value: s })),
    },
    // A "Share my contact" button; only the user's own number is accepted.
    { id: 'phone', type: 'contact', text: 'We need your phone number for the courier.' },
    { id: 'where', type: 'location', text: 'Where should we deliver?', button: '📍 Send my location' },
  ])
  .onFinish(({ answers, params, session, nav }) => {
    const orders = session.get<Order[]>('orders') ?? [];
    session.set('orders', [
      ...orders,
      { product: params.product, size: answers.size, phone: answers.phone.phoneNumber, location: answers.where },
    ]);
    return { text: '✅ Order placed! We will call you soon.', keyboard: [[nav.button('🧾 My orders', myOrders)]] };
  })
  .onCancel(() => ({ text: 'Checkout cancelled.' }));

const myOrders = page('orders').render(({ session }) => {
  const orders = session.get<Order[]>('orders') ?? [];
  if (!orders.length) return { text: 'No orders yet.' };
  return {
    text: [
      '**My orders**',
      ...orders.map((o) => {
        const name = products.find((p) => p.id === o.product)?.name ?? o.product;
        return md`- ${name}, size ${o.size}, deliver to ${o.location.latitude.toFixed(3)},${o.location.longitude.toFixed(3)}`;
      }),
    ],
  };
});

// Link buttons accept http(s):// and tg:// URLs only (Telegram rejects mailto:),
// so point to a support page or a Telegram account.
const support = page('support').render(({ nav }) => ({
  text: ['Questions? Write to us any time.', '', '✉️ support@example.com'],
  keyboard: [[nav.url('💬 Chat with support', process.env.SUPPORT_URL ?? 'https://t.me/BotSupport')]],
}));

// ---- main menu on the reply keyboard -------------------------------------------

// Pressing a menu button opens its page as a new message (or starts a dialogue),
// and leaves any dialogue in progress, like a /command.
const mainMenu = replyMenu(
  [
    [replyMenu.button('🛍 Catalog', catalog), replyMenu.button('🧾 My orders', myOrders)],
    [replyMenu.button('💬 Support', support), replyMenu.close()], // "✖️ Close menu" removes the keyboard
  ],
  { placeholder: 'Choose from the menu' },
);

const bot = new Bot(token);
const app = new EasyTG({ menu: mainMenu }).register(catalog, product, gallery, checkout, myOrders, support);

// Analytics: log what people look at and how checkouts go.
app.on('pageView', ({ ctx, page, mode }) => console.log(`[view] ${ctx.from?.id} ${page} (${mode})`));
app.on('dialogueFinish', ({ ctx, dialogue }) => console.log(`[done] ${ctx.from?.id} ${dialogue}`));
app.on('dialogueCancel', ({ ctx, dialogue, reason }) => console.log(`[cancel] ${ctx.from?.id} ${dialogue} (${reason})`));

bot.use(app);
bot.command('start', async (ctx) => {
  await app.showMenu(ctx, md`Welcome to the shop, **${ctx.from?.first_name ?? 'friend'}**! Use the menu below.`);
});
// A reply keyboard stays until the bot removes it (even after the bot stops).
bot.command('hide', (ctx) => app.hideMenu(ctx, 'Menu hidden. Send /start to show it again.'));
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });

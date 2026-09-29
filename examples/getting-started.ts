/**
 * The bot built step by step in docs/getting-started.md.
 *
 *   BOT_TOKEN=123:abc bun run examples/getting-started.ts
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page, replyMenu, type Auto } from '../src';

const products = [
  { id: 'tea', name: 'Green tea', price: 3 },
  { id: 'coffee', name: 'Coffee', price: 4 },
  { id: 'cake', name: 'Cheesecake', price: 5 },
];

// 1. A page: what to show, and which buttons lead where.
const home = page('home').render(({ ctx, nav }) => ({
  text: md`Welcome, **${ctx.from?.first_name ?? 'friend'}**! What would you like?`,
  keyboard: [[nav.button('🛍 Products', productList)], [nav.button('🧾 My orders', myOrders)]],
}));

// 2. Pages with params. The params type is checked wherever you link to the page.
const productList = page('products').render(({ nav }) => ({
  text: '**Products**',
  keyboard: [...products.map((p) => [nav.button(`${p.name} · $${p.price}`, productDetail, { id: p.id })]), [nav.home()]],
}));

const productDetail = page<{ id: string }>('product').render(({ params, nav }) => {
  const product = products.find((p) => p.id === params.id); // params are user input: check them
  if (!product) return nav.redirect(productList);
  return {
    text: [md`**${product.name}**`, `Price: $${product.price}`],
    keyboard: [[nav.button('🛒 Order', orderForm, { product: product.id })], [nav.button('⬅️ Back', productList)]],
  };
});

// 3. A dialogue: a multi-step form. Answers arrive typed in onFinish.
// Auto: the answers are read off the steps ({ quantity: string; note: string }); the params are declared.
const orderForm = dialogue<Auto, { product: string }>('order')
  .steps([
    {
      id: 'quantity',
      type: 'choice',
      text: 'How many?',
      columns: 3,
      options: ['1', '2', '3'].map((n) => ({ text: n, value: n })),
    },
    {
      id: 'note',
      type: 'text',
      text: 'Any note for the kitchen? (send "-" for none)',
      validate: (note) => note.length <= 200 || 'Please keep it under 200 characters.',
    },
  ])
  .onFinish(({ answers, params, session, nav }) => {
    // 4. The session keeps per-user state between updates.
    const orders = session.get<string[]>('orders') ?? [];
    session.set('orders', [...orders, `${answers.quantity} × ${params.product}`]);
    return { text: '✅ Order placed!', keyboard: [[nav.button('🧾 My orders', myOrders)], [nav.home()]] };
  })
  .onCancel(({ nav }) => nav.redirect(productList));

const myOrders = page('orders').render(({ session, nav }) => {
  const orders = session.get<string[]>('orders') ?? [];
  return {
    text: ['**My orders**', ...(orders.length ? orders.map((o) => `- ${o}`) : ['Nothing yet.'])],
    keyboard: [[nav.home()]],
  };
});

// 6. A main menu on the reply keyboard.
const mainMenu = replyMenu([
  [replyMenu.button('🛍 Products', productList), replyMenu.button('🧾 My orders', myOrders)],
  [replyMenu.close()], // "✖️ Close menu" removes the keyboard again
]);

// Wire it up.
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/getting-started.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({ menu: mainMenu }).register(home, productList, productDetail, orderForm, myOrders);

bot.use(app); // before your other handlers
bot.command('start', async (ctx) => {
  await app.showMenu(ctx, 'Welcome! Use the menu below.');
  await app.open(ctx, home);
});

await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });

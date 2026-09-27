# Getting started

In this guide you build a small shop bot: a menu, product pages, an order
form and an order history. It takes about ten minutes. The finished code is in
[`examples/getting-started.ts`](../examples/getting-started.ts).

## 1. Install

```bash
bun add easytg grammy
# or: npm install easytg grammy
```

Create a bot with [@BotFather](https://t.me/BotFather) and keep the token at
hand.

## 2. Your first page

A **page** is a screen: text plus buttons. You describe it once, and easytg
decides whether to send it as a new message or edit the current one.

```ts
import { Bot } from 'grammy';
import { EasyTG, md, page } from 'easytg';

const home = page('home').render(({ ctx }) => ({
  text: md`Welcome, **${ctx.from?.first_name}**! What would you like?`,
}));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG().register(home);

bot.use(app);                                        // before your other handlers
bot.command('start', (ctx) => app.open(ctx, home));  // /start shows the page
bot.start();
```

```bash
BOT_TOKEN=123:abc bun run bot.ts
```

Send `/start` to your bot. `md` is a template tag. Values you put in `${…}` are
escaped, so a user named `*[x](evil.com)*` can't inject formatting or links.

## 3. Buttons and navigation

`nav` builds buttons. `nav.button(label, page, params)` opens another page by
editing the current message in place.

```ts
const products = [
  { id: 'tea', name: 'Green tea', price: 3 },
  { id: 'coffee', name: 'Coffee', price: 4 },
];

const home = page('home').render(({ ctx, nav }) => ({
  text: md`Welcome, **${ctx.from?.first_name}**!`,
  keyboard: [[nav.button('🛍 Products', productList)]],
}));

const productList = page('products').render(({ nav }) => ({
  text: '**Products**',
  keyboard: [
    ...products.map((p) => [nav.button(p.name, productDetail, { id: p.id })]),
    [nav.home()],
  ],
}));

// Declare the params a page takes; links to it are type-checked.
const productDetail = page<{ id: string }>('product').render(({ params, nav }) => {
  const product = products.find((p) => p.id === params.id);
  if (!product) return nav.redirect(productList); // params are user input: always check them
  return {
    text: [md`**${product.name}**`, `Price: $${product.price}`],
    keyboard: [[nav.button('⬅️ Back', productList)]],
  };
});

const app = new EasyTG().register(home, productList, productDetail);
```

Pages can reference each other in any order. Forgetting a param is a compile
error:

```ts
nav.button('Coffee', productDetail);   // ✗ Property 'id' is missing
```

## 4. Forms with dialogues

A **dialogue** asks questions one step at a time and validates each answer.
It shows Back and Cancel buttons and cleans up its messages as it goes.

```ts
import { dialogue } from 'easytg';

const orderForm = dialogue<{ quantity: string; note: string }, { product: string }>('order')
  .steps([
    { id: 'quantity', type: 'choice', text: 'How many?', columns: 3,
      options: ['1', '2', '3'].map((n) => ({ text: n, value: n })) },
    { id: 'note', type: 'text', text: 'Any note for the kitchen?',
      validate: (note) => note.length <= 200 || 'Please keep it under 200 characters.' },
  ])
  .onFinish(({ answers, params }) => ({
    text: `✅ ${answers.quantity} × ${params.product} ordered. Note: ${answers.note}`,
  }))
  .onCancel(({ nav }) => nav.redirect(productList));
```

Start it from a button, just like a page:

```ts
keyboard: [[nav.button('🛒 Order', orderForm, { product: product.id })]]
```

Remember to register it: `app.register(home, productList, productDetail, orderForm)`.

## 5. Remember things with the session

`session` is a small key/value store per user. Changes are saved automatically
at the end of the update.

```ts
.onFinish(({ answers, params, session, nav }) => {
  const orders = session.get<string[]>('orders') ?? [];
  session.set('orders', [...orders, `${answers.quantity} × ${params.product}`]);
  return { text: '✅ Order placed!', keyboard: [[nav.button('🧾 My orders', myOrders)]] };
})

const myOrders = page('orders').render(({ session, nav }) => ({
  text: ['**My orders**', ...(session.get<string[]>('orders') ?? []).map((o) => `- ${o}`)],
  keyboard: [[nav.home()]],
}));
```

By default, sessions live in memory and are lost on restart. For production,
pass a storage adapter backed by your database, e.g. the
[SQLite adapter](../examples/storage/sqlite.ts):

```ts
const app = new EasyTG({ storage: new SqliteStorage('bot.sqlite') });
```

## 6. Test without Telegram

`easytg/testing` runs your bot against a fake Telegram API, with no token and
no network:

```ts
import { expect, test } from 'bun:test';
import { createTestBot } from 'easytg/testing';

test('shows the menu', async () => {
  const t = createTestBot();
  t.bot.use(app);
  t.bot.command('start', (ctx) => app.open(ctx, home));

  await t.message('/start');
  expect(t.find('sendMessage')[0].payload.text).toContain('Welcome');
});
```

## What's next

The [guide](guide.md) covers everything else:

- [Middlewares](guide.md#middlewares): login checks and admin-only pages
- [Text formatting](guide.md#text-formatting): Markdown, HTML, escaping
- [Button params](guide.md#button-params-inline-or-stored): tamper-proof buttons
- [Deep links](guide.md#deep-links): `t.me/yourbot?start=…`
- [Sending without an update](guide.md#sending-without-an-update): notifications from cron jobs and webhooks
- [Anti-spam](guide.md#anti-spam), [Languages](guide.md#languages), [Storage](guide.md#storage)

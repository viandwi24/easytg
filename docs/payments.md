# Payments

Sell digital goods for Telegram Stars (or physical goods through a payment
provider) with an `invoice` page.

## Showing an invoice

```ts
const buyPro = page('buy-pro').render(({ nav }) => ({
  invoice: {
    title: 'Pro plan',
    description: '30 days of Pro features',
    payload: 'pro:30',                        // your reference, 1–128 bytes, not shown
    currency: 'XTR',                          // Telegram Stars
    prices: [{ label: 'Pro plan', amount: 100 }],
    // providerToken: '…',                    // for other currencies, from @BotFather
    // options: { photo_url, need_email, max_tip_amount, subscription_period, … },
  },
  keyboard: [[nav.pay('⭐ Pay 100')], [nav.button('Back', home, {}, { mode: 'send' })]],
}));
```

- An invoice is always a new message (a button replaces its menu, unless the
  button has `{ mode: 'send' }`).
- A keyboard is optional; if there is one, its first button must be
  `nav.pay(text)`. Without a keyboard Telegram shows its own Pay button.
- Invoices can't have `text` or media: use `title`, `description` and
  `options.photo_url`.
- Digital goods must be sold for Stars (`XTR`, no provider token).

## Checkout and payment

```ts
new EasyTG({
  payments: {
    // Before the user is charged: true to accept, a message to refuse. Answered within 10 s.
    preCheckout: async ({ ctx, query, payload }) => ((await inStock(payload)) ? true : 'Sold out, sorry!'),

    // After the payment: deliver, then return what to show (like a render).
    onSuccess: async ({ ctx, payment, payload, session, t, nav }) => {
      await grantPro(ctx.from!.id, payment.telegram_payment_charge_id);
      return { text: '✅ Pro is active. Thank you!', keyboard: [[nav.home()]] };
    },
  },
});

app.on('payment', ({ ctx, payment, payload }) => analytics.track('paid', payment.total_amount));
```

- Without `preCheckout`, every checkout is accepted.
- If `preCheckout` throws, the checkout is refused with `texts.error` and the
  error is reported as an `error` event.
- Without `onSuccess`, the payment message goes on to your own handlers
  (`bot.on('message:successful_payment')`); the `payment` event fires either way.
- Without the `payments` option, easytg doesn't touch checkouts or payments.
- Payment updates never count towards [anti-spam](anti-spam.md).

Keep `payment.telegram_payment_charge_id`: it is what refunds need, and it is
unique per payment. If Telegram delivers the same update twice (e.g. a webhook
that answered too late), skip charge ids you have already processed.

```ts
await bot.api.refundStarPayment(userId, chargeId);
```

### Try it

Paying in the simulator is free: press the Pay button.

```ts playground
import { Bot } from 'grammy';
import { EasyTG, page } from 'easytg';

const home = page('home').render(({ nav }) => ({ text: 'Get Pro?', keyboard: [[nav.button('⭐ Buy Pro', buyPro, {}, { mode: 'send' })]] }));

const buyPro = page('buy-pro').render(({ nav }) => ({
  invoice: { title: 'Pro plan', description: '30 days of Pro features', payload: 'pro:30', currency: 'XTR', prices: [{ label: 'Pro plan', amount: 100 }] },
  keyboard: [[nav.pay('⭐ Pay 100')]],
}));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG({
  payments: {
    preCheckout: ({ payload }) => payload === 'pro:30' || 'Unknown product',
    onSuccess: ({ payment, nav }) => ({ text: `✅ Pro is active. Receipt: ${payment.telegram_payment_charge_id}`, keyboard: [[nav.home()]] }),
  },
}).register(home, buyPro);
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.start();
```

[`examples/payments.ts`](../examples/payments.ts) is a small Stars shop with a
stock check and an admin refund command.

/**
 * Selling digital goods for Telegram Stars.
 *
 *   BOT_TOKEN=123:abc ADMIN_ID=<your user id> bun run examples/payments.ts
 *
 * Shows: `invoice` content with `nav.pay`, `payments.preCheckout` (stock
 * check before the user is charged), `payments.onSuccess` (deliver and show a
 * receipt), the `payment` event, and a refund command for the admin.
 * Stars payments need no provider token; paying with Stars in a test bot
 * really spends them, so refund yourself with /refund afterwards.
 */
import { Bot } from 'grammy';
import { EasyTG, md, page } from '../src';

const products = [
  { id: 'wallpaper', title: 'Wallpaper pack', description: '20 HD wallpapers', stars: 1, stock: Infinity },
  { id: 'sticker', title: 'Sticker pack', description: 'A limited sticker pack', stars: 2, stock: 3 },
];
/** Stands in for your database. */
const sales: Array<{ userId: number; product: string; chargeId: string }> = [];

const home = page('home').render(({ nav }) => ({
  text: ['**Shop**', 'Everything is paid with ⭐ Telegram Stars.'],
  keyboard: [...products.map((p) => [nav.button(`${p.title} · ⭐ ${p.stars}`, product, { id: p.id })]), [nav.button('🧾 My purchases', purchases)]],
}));

const product = page<{ id: string }>('product').render(({ params, nav }) => {
  const item = products.find((p) => p.id === params.id);
  if (!item) return nav.redirect(home);
  return {
    // The invoice message: title, description and price come from here.
    invoice: {
      title: item.title,
      description: item.description,
      payload: item.id, // given back at checkout and after payment
      currency: 'XTR',
      prices: [{ label: item.title, amount: item.stars }],
    },
    // Optional keyboard; the Pay button must come first.
    keyboard: [[nav.pay(`Pay ⭐ ${item.stars}`)], [nav.button('⬅️ Back to shop', home, {}, { mode: 'send' })]],
  };
});

const purchases = page('purchases').render(({ ctx, nav }) => {
  const mine = sales.filter((s) => s.userId === ctx.from?.id);
  return {
    text: ['**My purchases**', ...(mine.length ? mine.map((s) => md`- ${s.product}`) : ['None yet.'])],
    keyboard: [[nav.home()]],
  };
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc ADMIN_ID=<id> bun run examples/payments.ts');
  process.exit(1);
}
const ADMIN_ID = Number(process.env.ADMIN_ID ?? 0);

const bot = new Bot(token);
const app = new EasyTG({
  payments: {
    // Last check before the user pays; answer within 10 seconds.
    preCheckout: ({ payload }) => {
      const item = products.find((p) => p.id === payload);
      if (!item) return 'This product no longer exists.';
      return item.stock > 0 || 'Sold out, sorry!';
    },
    // Paid: deliver, then show a receipt (like a page render).
    onSuccess: ({ ctx, payload, payment, nav }) => {
      const item = products.find((p) => p.id === payload)!;
      item.stock--;
      sales.push({ userId: ctx.from!.id, product: item.title, chargeId: payment.telegram_payment_charge_id });
      return {
        text: [md`✅ Thanks! **${item.title}** is yours.`, md`Receipt: \`${payment.telegram_payment_charge_id}\``],
        keyboard: [[nav.button('🧾 My purchases', purchases)], [nav.home()]],
      };
    },
  },
}).register(home, product, purchases);

// Also emitted: e.g. for analytics or notifying the owner.
app.on('payment', ({ ctx, payment }) => {
  console.log(`${ctx.from?.id} paid ${payment.total_amount} ${payment.currency} for ${payment.invoice_payload}`);
});

bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));

// /refund <user id> <charge id>, e.g. to undo a test purchase.
bot.command('refund', async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return;
  const [userId, chargeId] = ctx.match.split(' ');
  if (!userId || !chargeId) return void (await ctx.reply('Usage: /refund <user id> <charge id>'));
  await ctx.api.refundStarPayment(Number(userId), chargeId);
  await ctx.reply('Refunded.');
});
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start in Telegram.`) });

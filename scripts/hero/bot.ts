import { Bot } from 'grammy';
import { EasyTG, md, page, paginate } from 'easytg';
import { products } from './products';

const home = page('home').render(({ ctx, nav }) => ({
  text: md`👋 Hi **${ctx.from?.first_name}**, welcome to the shop!`,
  keyboard: [[nav.button('🛍 Browse products', shop)]],
}));

const shop = page<{ page?: string }>('shop').render((args) => {
  const { offset, buttons } = paginate(args, { total: products.length, perPage: 1 });
  const p = products[offset]!;
  return {
    photo: p.photo,
    text: [md`**${p.name}** · $${p.price}`, p.about],
    keyboard: [
      [args.nav.button('🛒 Buy now', order, { id: p.id })],
      buttons, // ⬅️ ➡️ edit this photo in place
      [args.nav.back()],
    ],
  };
});

const order = page<{ id: string }>('order').render(({ params }) => ({
  text: md`✅ Order placed: **${params.id}**`,
}));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG().register(home, shop, order);
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.start();

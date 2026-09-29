/**
 * Inline mode: share pages into any chat with `@yourbot query`.
 *
 *   BOT_TOKEN=123:abc bun run examples/inline.ts
 *
 * Enable inline mode for your bot in @BotFather (/setinline) first. Then type
 * `@yourbot tea` in any chat: the results are product pages, and their buttons
 * keep working in the sent message (anyone in that chat can press them).
 *
 * Shows: `app.inlineResult`, `.params(schema)` with a Standard Schema (a tiny
 * hand-written one here; zod or valibot work the same), `media.cacheFileIds`
 * for photos sent by URL, and `autoRetry`.
 */
import { Bot } from 'grammy';
import { EasyTG, autoRetry, page, type StandardSchemaV1 } from '../src';

const products = [
  { id: 1, name: 'Green tea', price: 3, photo: 'https://picsum.photos/id/225/600/400' },
  { id: 2, name: 'Black tea', price: 3, photo: 'https://picsum.photos/id/1060/600/400' },
  { id: 3, name: 'Espresso', price: 4, photo: 'https://picsum.photos/id/766/600/400' },
];

/** `{ id: "2" }` → `{ id: 2 }`, rejecting anything else. With zod: `z.object({ id: z.coerce.number().int() })`. */
const productParams: StandardSchemaV1<unknown, { id: number }> = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate: (value) => {
      const id = Number((value as { id?: string }).id);
      return Number.isInteger(id) ? { value: { id } } : { issues: [{ message: 'id must be a number', path: ['id'] }] };
    },
  },
};

const product = page<{ id: string }>('product')
  .params(productParams)
  .render(({ params, nav }) => {
    const item = products.find((p) => p.id === params.id);
    if (!item) return { text: 'This product is gone.' };
    return {
      photo: item.photo, // sent by URL once, then by the file id Telegram gave it
      text: [`**${item.name}**`, `Price: $${item.price}`],
      keyboard: [[nav.self('👍 Like')]],
      toast: 'Thanks!',
    };
  });

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/inline.ts');
  process.exit(1);
}

const bot = new Bot(token);
bot.api.config.use(autoRetry());
const app = new EasyTG({ media: { cacheFileIds: true } }).register(product);
bot.use(app);

bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.toLowerCase();
  const found = products.filter((p) => p.name.toLowerCase().includes(query));
  const results = await Promise.all(
    found.map((p) =>
      app.inlineResult(ctx, product, { params: { id: String(p.id) }, title: p.name, description: `$${p.price}`, thumbnailUrl: p.photo }),
    ),
  );
  await ctx.answerInlineQuery(results, { cache_time: 0 });
});
bot.command('start', (ctx) => ctx.reply(`Type @${ctx.me.username} tea in any chat.`));
bot.catch((err) => console.error('Bot error:', err.error));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Type @${me.username} in any chat.`) });

# Inline mode

In inline mode users type `@yourbot query` in any chat and pick one of your
results, which is then sent into that chat. easytg turns pages into such
results, buttons included: pressing them later updates the sent message in
place, like any menu.

Turn inline mode on for your bot in @BotFather (`/setinline`) first.

```ts
const product = page<{ id: string }>('product').render(({ params, nav }) => ({
  text: `**${name(params.id)}**`,
  keyboard: [[nav.self('🔄 Refresh')]],
}));

bot.on('inline_query', async (ctx) => {
  const found = search(ctx.inlineQuery.query);
  const results = await Promise.all(
    found.map((p) => app.inlineResult(ctx, product, { params: { id: p.id }, title: p.name, description: `$${p.price}` })),
  );
  await ctx.answerInlineQuery(results, { cache_time: 0 });
});
```

- A text page becomes an article; a page with a `photo` (file id or URL)
  becomes a photo with its text as the caption. Other content can't be an
  inline result.
- `title`, `description` and `thumbnailUrl` describe the result in the list.
  `id` defaults to one derived from the page and params.
- Middlewares run and redirects are followed, like for any render.
- The message ends up in someone else's chat, so its buttons can be pressed by
  anyone there: they are never bound to a user. Keep what they do safe for
  that, and use `buttons: { params: 'stored' }` or `'signed'` if the params
  matter.
- There is no chat to talk in, so these pages can't start dialogues (a render
  returning `nav.startDialogue` throws), and text that doesn't fit one message
  is cut (with a warning in the log).

## Try it

Type `@demo_bot tea` in the message field, pick a result, then press its button.

```ts playground start=""
import { Bot } from 'grammy';
import { EasyTG, md, page } from 'easytg';

const teas = [
  { id: 'green', name: 'Green tea', price: 3 },
  { id: 'black', name: 'Black tea', price: 3 },
  { id: 'mint', name: 'Mint tea', price: 4 },
];

const product = page<{ id: string }>('product').render(({ params, nav }) => {
  const tea = teas.find((t) => t.id === params.id);
  return { text: md`**${tea?.name ?? 'Gone'}** · $${tea?.price ?? 0}`, keyboard: [[nav.self('👍 Like')]], toast: 'Thanks!' };
});

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG().register(product);
bot.use(app);
bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.toLowerCase();
  const found = teas.filter((t) => t.name.toLowerCase().includes(query));
  const results = await Promise.all(
    found.map((t) => app.inlineResult(ctx, product, { params: { id: t.id }, title: t.name, description: `$${t.price}` })),
  );
  await ctx.answerInlineQuery(results, { cache_time: 0 });
});
bot.start();
```


[`examples/inline.ts`](../examples/inline.ts) is a small catalog shared inline.

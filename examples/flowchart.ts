/**
 * A bot that draws its own map: `app.flowchart()` turns the pages, dialogues,
 * /commands and menu buttons into a Mermaid diagram, with the buttons and
 * redirects seen while people used the bot.
 *
 *   BOT_TOKEN=123:abc bun run examples/flowchart.ts
 *
 * Click around a little (open the catalog, a product, order something), then
 * send /flow: the diagram grows with what you used. Paste it into a GitHub
 * issue or README (```mermaid), or open it in the Mermaid Live Editor with the
 * button. In `easytg preview`, the Flow tab shows it as you click.
 */
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, mermaidLiveUrl, page, replyMenu } from '../src';

const teas = [
  { id: 'green', name: 'Green tea' },
  { id: 'black', name: 'Black tea' },
];

const home = page('home').render(({ nav }) => ({
  text: ['🍵 **Tea shop**', 'Use the menu, then send /flow to see the map of this bot.'],
  keyboard: [[nav.button('🛍 Catalog', catalog)], [nav.button('ℹ️ About', about)]],
}));

const catalog = page('catalog').render(({ nav }) => ({
  text: '**Catalog**',
  keyboard: [...teas.map((t) => [nav.button(t.name, product, { id: t.id })]), [nav.home()]],
}));

const product = page<{ id: string }>('product').render(({ params, nav }) => {
  const tea = teas.find((t) => t.id === params.id);
  if (!tea) return nav.redirect(catalog); // shows up as a dotted "redirect" arrow
  return { text: md`**${tea.name}**`, keyboard: [[nav.button('🛒 Order', order, { tea: tea.id })], [nav.back()]] };
});

const order = dialogue<{ cups: '1' | '2' | '3' }, { tea: string }>('order')
  .steps([{ id: 'cups', type: 'choice', text: 'How many cups?', columns: 3, options: ['1', '2', '3'].map((n) => ({ text: n, value: n as '1' | '2' | '3' })) }])
  .onFinish(({ nav }) => nav.redirect(thanks))
  .onCancel(({ nav }) => nav.redirect(catalog));

const thanks = page('thanks').render(({ nav }) => ({ text: '✅ Ordered!', keyboard: [[nav.button('🛍 More tea', catalog)], [nav.home()]] }));
const about = page('about').render(({ nav }) => ({ text: 'A small shop, to show `app.flowchart()`.', keyboard: [[nav.home()]] }));

// The map itself, as a page: the diagram in a code block and a link to view it drawn.
const flow = page('flow').render(({ app, nav }) => {
  const chart = app.flowchart();
  return {
    text: ['🗺 **This bot, so far**', md`\`\`\`mermaid\n${chart}\n\`\`\``],
    keyboard: [[nav.url('🔎 Open in Mermaid Live', mermaidLiveUrl(chart))], [nav.home()]],
  };
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Usage: BOT_TOKEN=123:abc bun run examples/flowchart.ts');
  process.exit(1);
}

const bot = new Bot(token);
const app = new EasyTG({ menu: replyMenu([[replyMenu.button('🛍 Catalog', catalog), replyMenu.button('🗺 Map', flow)]]) })
  .register(catalog, product, order, thanks, about)
  .command('start', home, { description: 'Main menu' })
  .command('flow', flow, { description: 'The map of this bot' });

bot.use(app);
bot.catch((err) => console.error('Bot error:', err.error));
await app.syncCommands(bot);
// What is known before anyone used the bot: the commands and the menu.
console.log(app.flowchart({ observed: false }));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ onStart: (me) => console.log(`@${me.username} is running. Send /start, click around, then /flow.`) });

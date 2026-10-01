// A plain-JavaScript bot for the Node.js smoke test (scripts/node-smoke.mjs).
import { Bot } from 'grammy';
import { EasyTG, page } from '../../dist/index.js';

const home = page('home').render(({ nav }) => ({ text: 'Hello from Node', keyboard: [[nav.button('Next', next)]] }));
const next = page('next').render(() => ({ text: 'Next page' }));

const bot = new Bot(process.env.BOT_TOKEN);
const app = new EasyTG({ logger: false }).register(next).command('start', home);
bot.use(app);
await bot.start();

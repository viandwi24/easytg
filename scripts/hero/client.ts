/** The hero page: runs bot.ts against a simulator and plays a short conversation. */
import { TelegramSimulator } from '@easytg/simulator';
import { mountChat } from '@easytg/simulator/element';

const sim = new TelegramSimulator({
  user: { first_name: 'Alex', language_code: 'en' },
  bot: { first_name: 'Tee Shop', username: 'teeshop_bot' },
});
const global = globalThis as unknown as Record<string, unknown>;
global.heroSim = sim;
global.process = { env: { BOT_TOKEN: sim.token } };

const theme = document.documentElement.dataset.theme as 'light' | 'dark';
const chat = mountChat(document.querySelector('#chat')!, sim, { theme });
chat.setAttribute('sidebar', 'hide');

// Fetch the photos first: the screenshot is taken on a timer, not when they arrive.
const { products } = await import('./products');
await Promise.all(products.map((p) => new Promise((done) => Object.assign(new Image(), { onload: done, onerror: done, src: p.photo }))));

await import('./bot');
await sim.send('/start');
await sim.tap('🛍 Browse products');
await sim.tap('➡️');


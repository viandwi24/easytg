# @easytg/simulator

A Telegram that lives in memory: a Bot API your [grammY](https://grammy.dev)
bot talks to, simulated users who send messages, press buttons, pay and use
inline mode, and a Telegram-like chat window for the browser. No token, no
network: nothing reaches Telegram. Runs in Bun, Node, Deno and browsers.

Part of [easytg](https://github.com/viandwi24/easytg), but it works with any
grammY bot. easytg re-exports it as `easytg/simulator`.

```bash
bun add @easytg/simulator grammy    # or npm install
```

```ts
import { Bot } from 'grammy';
import { TelegramSimulator, messageText } from '@easytg/simulator';

const sim = new TelegramSimulator();
const bot = new Bot(sim.token);
sim.connect(bot);                    // or: const bot = sim.createBot()

bot.command('start', (ctx) => ctx.reply('Hi!', {
  reply_markup: { inline_keyboard: [[{ text: 'Next', callback_data: 'next' }]] },
}));
bot.callbackQuery('next', (ctx) => ctx.editMessageText('Next page'));

await sim.send('/start');            // as the default user, in their private chat
await sim.tap('Next');
console.log(messageText(sim.last()!.message)); // "Next page"
```

| import | |
|---|---|
| `@easytg/simulator` | `TelegramSimulator`, `parseHtml`, `parseMarkdownV2`, `messageText`, `richPlainText`, `richButtons`, `richHtml` |
| `@easytg/simulator/element` | `<easytg-chat>`, `mountChat`: a chat window for a simulator (browsers) |
| `@easytg/simulator/load` | `loadBot`, `interceptBotApi`, `trackBots`: run a bot's own file against a simulator (Bun, Node) |

Documentation: [docs/simulator.md](https://github.com/viandwi24/easytg/blob/main/docs/simulator.md).
Try it in the browser: the [easytg playground](https://viandwi24.github.io/easytg/playground).

MIT licensed.

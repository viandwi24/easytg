# Preview and recorded tests

`easytg preview` runs your bot's file, unchanged, against a simulated
Telegram and opens a Telegram-like chat in your browser. No token, no
network: nothing reaches Telegram. Design a flow, press the buttons, change
the code: the bot restarts, the chat stays.

```bash
bunx easytg preview src/bot.ts
```

```
  easytg preview: http://127.0.0.1:4545
  src/bot.ts runs against a simulated Telegram. Ctrl+C to stop.
```

- Your file runs as it is: `new Bot(process.env.BOT_TOKEN)`, your storage,
  your database, `await bot.start()`. `BOT_TOKEN` is set to a fake token, and
  every call to `api.telegram.org` goes to the preview instead. A file that
  doesn't call `bot.start()` (a webhook setup) is started for you.
- The bot runs in its own process and restarts when a file in its folder
  changes (`--no-watch` turns that off); the chat keeps its messages and
  shows "🔄 Restarted". Anything your bot keeps in memory starts over.
- The page shows the bot's output, every Bot API call, and the bot's
  [flow map](flowchart.md) (the **Flow** tab) next to the chat.
- **Two chats** puts a second chat window beside the first, as another user
  (added when there is none): try likes, relays and support chats from both
  sides at once. On a phone, the windows stack.
- The bot's process stops with the preview, even when the preview is killed.
  Photos and files the bot sends are shown; you can send photos, files,
  your location and contact from 📎.
- It needs [Bun](https://bun.sh), also for Node projects: `bunx` runs it
  and Bun runs TypeScript directly.

| option | |
|---|---|
| `--users <n>` | more users to switch between (Alice, Bob, …), e.g. to try likes, relays or groups |
| `--group` | a group with every user |
| `--latency <ms>` | delay every API call, to see [loading indicators](pages.md#slow-pages) |
| `--port <n>` | the page's port (default 4545, or the next free one) |
| `--no-open` | don't open the browser |

The chat window is the one from the [simulator](simulator.md#a-chat-window),
like in the [playground](https://viandwi24.github.io/easytg/playground).

## Recording a test

Press **Export test**: what you did in the chat becomes a `bun test` file. It
loads your bot file the same way, replays your messages and button presses,
and checks what the chat showed after each:

```ts
import { afterAll, expect, test } from 'bun:test';
import { TelegramSimulator } from 'easytg/simulator';
import { loadBot } from 'easytg/simulator/load';

const sim = new TelegramSimulator({ user: { is_bot: false, id: 1001, first_name: 'You', language_code: 'en' } });
const { stop } = await loadBot('./src/bot.ts', { simulator: sim });
afterAll(stop);

function screen(chat = sim.user.id) { /* the last message: its text and inline buttons */ }

test('recorded conversation', async () => {
  await sim.send('/start');
  expect(screen()).toEqual({ text: 'Welcome! What would you like?', buttons: ['🛍 Products', '🧾 My orders'] });
  await sim.tap('🛍 Products');
  expect(screen()).toEqual({ text: 'Products', buttons: ['Green tea · $3', 'Coffee · $4', '🏠 Home'] });
});
```

Save it next to your code (e.g. `bot.test.ts`) and run `bun test` from the
project folder. Edit it like any test: loosen checks on text that changes
(dates, random ids), add your own.

## `loadBot` in your own tests

```ts
import { loadBot } from 'easytg/simulator/load';

const { sim, bots, stop } = await loadBot('./src/bot.ts');
await sim.send('/start');
await sim.tap('🛍 Products');       // the newest button with this label, inline or reply keyboard
expect(sim.last()?.message.text).toContain('Products');
await stop();
```

- The file is imported once per process (modules run once), so load it once
  per test file and share it between tests.
- It needs a server runtime (Bun or Node ≥ 20); the file must use the
  `grammy` of your project.
- `interceptBotApi(target)` is the piece underneath: it sends grammY's calls
  to a fetch handler (`(request) => sim.handleRequest(request)`) or to
  another Bot API URL, and returns a function that undoes it.

[Testing](testing.md) covers `createTestBot`, the lighter fake API for unit
tests.

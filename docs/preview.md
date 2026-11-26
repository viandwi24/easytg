# Studio, preview and recorded tests

**easytg studio** runs your bot's file, unchanged, against a simulated
Telegram and shows it in the browser like Telegram on a computer: profiles,
chats, groups, channels and topics, next to the bot's output, every Bot API
call, its [flow map](flowchart.md) and **Export test**. No token, no network:
nothing reaches Telegram. Change the code: the bot restarts, the chats stay.

```bash
bun add -d @easytg/studio @easytg/simulator
bunx easytg preview src/bot.ts          # = bunx easytg-studio src/bot.ts --open
```

```
  easytg studio: http://127.0.0.1:4646
  src/bot.ts runs against a simulated Telegram. Ctrl+C to stop.
```

- Your file runs as it is: `new Bot(process.env.BOT_TOKEN)`, your storage,
  your database, `await bot.start()`. `BOT_TOKEN` is set to a fake token, and
  every call to `api.telegram.org` goes to the studio instead. A file that
  doesn't call `bot.start()` (a webhook setup) is started for you.
- The bot runs in its own process and restarts when a file in its folder
  changes (`--no-watch` turns that off; test files like `*.test.ts` don't
  count); the chats keep their messages and show "🔄 Restarted", and the
  Output tab says which file changed. Anything your bot keeps in memory
  starts over.
- **Profiles**: switch the user you type as, or make one (name, username,
  language), at the bottom of the chat list. **✎** above it makes a group, a
  supergroup, a group with topics or a channel with the profiles you pick.
- The panel shows the bot's output, every Bot API call (request and result),
  the simulated world (profiles, groups, members, a slow network) and, for
  easytg bots, the **Flow** map.
- Every Bot API call takes 120–280 ms, like a real network, so pressed buttons
  show their spinner ([loading indicators](pages.md#slow-pages)).
  `--latency 0` turns it off.
- It needs [Bun](https://bun.sh), also for Node projects: `bunx` runs it and
  Bun runs TypeScript directly.

| option | |
|---|---|
| `--users <n>` | more profiles to start with (Alice, Bob, …), e.g. to try likes, relays or groups |
| `--group` | a group with every profile |
| `--latency <ms>` | delay every Bot API call (default 120–280 ms; 0 for none) |
| `--port <n>` | the page's port (default 4646, or the next free one) |
| `--no-open` | don't open the browser (`easytg preview` opens it; `easytg-studio` only with `--open`) |
| `--no-watch` | don't restart on changes |

**Bots in other languages** run with `easytg-studio --cmd "python bot.py"`:
the command gets `TELEGRAM_API_ROOT` and a fake `BOT_TOKEN`; point the
library's Bot API URL at it (the studio's **Connect** tab has snippets for
grammY, Telegraf, python-telegram-bot and aiogram). See
[the studio's README](../packages/studio/README.md).

The chat window is the one from the [simulator](simulator.md#a-chat-window),
like in the [playground](https://viandwi24.github.io/easytg/playground).

## Recording a test

Use the chat, then **Test → Export test**: what you did becomes a `bun test`
file. It loads your bot file the same way, replays your messages and button
presses, and checks what the chat showed after each:

```ts
import { afterAll, expect, test } from 'bun:test';
import { TelegramSimulator } from '@easytg/simulator';
import { loadBot } from '@easytg/simulator/load';

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
import { loadBot } from '@easytg/simulator/load';   // or 'easytg/simulator/load'

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

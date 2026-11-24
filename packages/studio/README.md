# easytg studio (experimental, not published yet)

A Telegram for developing bots. Your bot runs against a simulated Telegram
([`@easytg/simulator`](../simulator/README.md)), and the studio's page (at the
URL it prints; `--open` opens it) looks like Telegram on a computer: profiles,
a chat list, groups. The panel next to it shows the bot's output, every Bot API call (request and result),
the simulated world, and how to connect. No token, no network: nothing
reaches Telegram, and it doesn't use up a bot on @BotFather.

```bash
bun run studio examples/shop.ts              # in this repository
bunx easytg-studio src/bot.ts                # (once published)
easytg-studio --cmd "python bot.py"          # a bot in any language
```

- **JavaScript/TypeScript**: the file runs unchanged with Bun; its calls to
  `api.telegram.org` come to the studio (grammY, or anything using `fetch`).
  A file that doesn't start polling is started for you.
- **Any other language** (`--cmd`): the command gets `TELEGRAM_API_ROOT`,
  `BOT_TOKEN` and `TELEGRAM_BOT_TOKEN`. Point the library's Bot API URL at
  `TELEGRAM_API_ROOT` (the **Connect** tab has snippets for grammY,
  Telegraf, python-telegram-bot and aiogram). Long polling works; webhooks
  don't.
- **Hot restart**: the bot restarts when a code file changes (also `.py`,
  `.go`, …); the chats stay and show "🔄 Restarted". **Restart** and
  **Start over** (clears the chats; profiles and groups stay) are at the top.
- **Profiles, groups, channels, topics**: switch or create profiles at the
  bottom of the chat list, and make groups, supergroups, groups with topics
  and channels with ✎ above it. The **World** tab does the same, adds and
  removes members ("joined the group" messages, like Telegram), and blocks
  the bot as a user.
- **A real network's pace**: every Bot API call takes 120–280 ms, so pressed
  buttons show a spinner and edits arrive a moment later. **World → Network**
  switches to none, slow or very slow; `--latency 0` starts without it.
- A wrong token gets `401 Unauthorized`, like Telegram.

| option | |
|---|---|
| `--cmd "<command>"` | run a bot in any language instead of a file |
| `--port <n>` | default 4646, or the next free one |
| `--users <n>` | start with more profiles (Alice, Bob, …) |
| `--group` | start with a group of every profile |
| `--latency <ms>` | delay every Bot API call (default 120–280; 0 for none) |
| `--watch <dir>` | the folder watched for changes (default: the file's folder, or the working directory) |
| `--open` | open the studio in the browser (it doesn't by itself) |
| `--no-watch` | don't restart on changes |

Needs [Bun](https://bun.sh). In this repository it's registered as the
`easytg-studio` command of the root package for development; `bun run release`
refuses to release easytg while that entry is there, since `packages/studio`
isn't part of the easytg package.

# easytg documentation

New to easytg? Start with [Getting started](getting-started.md): a small shop
bot built step by step. Upgrading? See [Migrating](migration.md). Looking for
a method? See the [API reference](app.md).

On the [docs site](https://viandwi24.github.io/easytg/), code blocks marked
"Try it" run in a Telegram simulator in your browser, and so does every example
in the [playground](https://viandwi24.github.io/easytg/playground).

## Building the UI

| | |
|---|---|
| [Pages](pages.md) | pages, `nav`, delivery modes, keeping messages, `app.edit`, params validation (functions or zod/valibot), long messages, middlewares, Back, `refreshEveryMs` |
| [Media](media.md) | photos, videos, documents, audio, albums, copies from a channel, `protectContent`, file id cache |
| [Main menu](menu.md) | a reply-keyboard menu with `replyMenu` |
| [Flow map](flowchart.md) | `app.flowchart()`: the bot as a Mermaid diagram of pages, dialogues, commands and buttons |
| [Commands](commands.md) | `app.command`: `/commands` for pages and dialogues, and Telegram's command menu (`syncCommands`) |
| [Dialogues](dialogues.md) | multi-step forms: text, files, choices, several options, numbers, dates (calendar), contacts, locations, Mini Apps; typed answers, schemas, `when`, timeouts |
| [Text input](text-input.md) | `page.onText`: search boxes and other typed input on a page |
| [Text formatting](formatting.md) | Markdown, HTML, safe `md` / `html` templates |
| [Rich messages](rich-messages.md) | `rich`: headings, tables, task lists, details, formulas, pictures and buttons in one message (Bot API 10.3) |
| [Languages](i18n.md) | your messages with `t()` (placeholders, plurals), `setLocale`, built-in texts |
| [Inline mode](inline-mode.md) | pages as `@yourbot query` results |
| [Mini Apps](mini-apps.md) | opening Mini Apps, checking `initData`, answering, sharing, `sendData` |
| [Groups](groups.md) | menu ownership, pages for one member only (ephemeral), admin-only pages, chat-wide state, privacy mode |
| [Streaming](streaming.md) | `app.stream`: an AI answer appearing as it is written (drafts, rich or plain), with a stop button |

## State and data

| | |
|---|---|
| [Sessions](sessions.md) | state per chat, per user across chats, and chat-wide; typed keys, expiry, migrations |
| [Storage](storage.md) | `MemoryStorage`, `SqliteStorage`, `RedisStorage`, custom adapters |
| [Button params](button-params.md) | inline, stored and signed buttons |
| [Deep links](deep-links.md) | `t.me/yourbot?start=…` links to pages and dialogues |

## Beyond a single update

| | |
|---|---|
| [Sending without an update](proactive.md) | `sendTo`, `sendLater`, `broadcast`, `broadcastLater` |
| [Relays](relay.md) | `app.relay`: two users talking through the bot (anonymous chats, support) |
| [Scheduled tasks](scheduler.md) | `task()`, `app.schedule`, recurring tasks, `deleteLater`, `deleteAfterMs` |
| [Queues](queues.md) | concurrency limits for slow jobs |
| [Payments](payments.md) | invoices, Telegram Stars, checkout, `onSuccess` |

## Running in production

| | |
|---|---|
| [Anti-spam](anti-spam.md) | rate limits, mutes, double taps |
| [Scaling](scaling.md) | sequential updates, Telegram's rate limits (`app.throttle`), several processes (`cluster`), webhooks |
| [Serverless and edge](serverless.md) | Cloudflare Workers, Deno Deploy, Vercel: webhooks, Redis over HTTP, cron for tasks |
| [Security notes](security.md) | what to trust and what not |
| [Events](events.md) | `update` (timings), `pageView`, `sent`, `spam`, `error`, `payment`, … |
| [Error helpers](errors.md) | `isChatUnreachable`, `isTransient`, `retryAfterMs`, `autoRetry` |
| [Options](options.md) | every option of `new EasyTG()` |
| [API reference](app.md) | every export and `app` method |
| [Migrating](migration.md) | breaking changes between versions |
| [Testing](testing.md) | `easytg/testing`: a fake Telegram API for your tests |
| [Preview and recorded tests](preview.md) | `easytg preview`: your bot file in a simulated Telegram in the browser; tests recorded from it; `loadBot` |
| [Simulator](simulator.md) | `easytg/simulator`: an in-memory Telegram with users, groups and a browser chat window; easytg in the browser |

## Examples

Runnable bots (`BOT_TOKEN=… bun run examples/<file>`) that show features in context:

| Example | Features |
|---|---|
| [`getting-started.ts`](../examples/getting-started.ts) | pages, typed navigation, a dialogue, sessions, main menu |
| [`shop.ts`](../examples/shop.ts) | reply-keyboard menu with close button, pagination, `nav.back()`, photos, albums, `choice`/`contact`/`location` steps, events |
| [`search.ts`](../examples/search.ts) | `page.onText`, `i18n.messages` with `t` / `t.md` and plurals, a language picker with `setLocale` |
| [`media.ts`](../examples/media.ts) | photo, video, GIF, generated document, audio, album |
| [`course.ts`](../examples/course.ts) | `copy` from a storage channel, `protectContent`, `{ mode: 'send' }`, `.params(parse)`, signed buttons, `prepareProactive`, `allowedUsers`, `app.edit`, `deleteAfterMs` |
| [`reminders.ts`](../examples/reminders.ts) | scheduled tasks: `task`, `schedule`, `everyMs`, `cancelTask`, `deleteLater`, SQLite |
| [`queue.ts`](../examples/queue.ts) | `app.queue`, `app.enterQueue`, `perUser`, `queueWait`, `page.loading`, `app.withLoading` |
| [`payments.ts`](../examples/payments.ts) | Telegram Stars invoices, `preCheckout`, `onSuccess`, refunds |
| [`inline.ts`](../examples/inline.ts) | `app.inlineResult`, `.params(schema)`, `media.cacheFileIds`, `autoRetry` |
| [`mini-app.ts`](../examples/mini-app.ts) | a bot with its Mini App: `verifyInitData`, `withUser`, `answerWebAppQuery`, `prepareShare`, a `webApp` step, `replyMenu.webApp` |
| [`sessions.ts`](../examples/sessions.ts) | `session` (this chat), `userSession` (every chat), `chatSession` (shared), typed keys |
| [`loading.ts`](../examples/loading.ts) | `page.loading` (placeholder, "typing…", toast), `dialogue.loading`, `app.withLoading`, a default |
| [`throttle.ts`](../examples/throttle.ts) | `app.throttle` with per-chat rules, `autoRetry`, a paced broadcast |
| [`group.ts`](../examples/group.ts) | `chatSession`, `requireChatAdmin`, `refreshEveryMs`, `dialogue.timeout` |
| [`production.ts`](../examples/production.ts) | `RedisStorage` / `SqliteStorage`, `cluster`, webhooks, the scheduler, `autoRetry` |
| [`broadcast.ts`](../examples/broadcast.ts) | `broadcast` in the background with progress, `broadcastLater`, dialogue middlewares, `pageView`/`spam` events |
| [`match.ts`](../examples/match.ts) | a reply-keyboard menu acting on the card on screen, `showMenu` / `hideMenu` in renders, a dialogue with `when` and a photo, `sendTo` for likes and matches, `app.relay` chats, `app.command` + `syncCommands` |
| [`booking.ts`](../examples/booking.ts) | `date` (calendar), `number` and `multiChoice` steps, `when` |
| [`support.ts`](../examples/support.ts) | a support desk with `app.relay`: tickets, `relay.filter`, replies and edits carried over, `relayEnd`, rating |
| [`team.ts`](../examples/team.ts) | a group board: ephemeral pages and a dialogue (`mode: 'ephemeral'`), ephemeral commands, `nav.disabled` |
| [`ai-chat.ts`](../examples/ai-chat.ts) | `app.stream` with `rich`: an answer streamed as a rich draft with ⏹ Stop, then a rich message |
| [`rich.ts`](../examples/rich.ts) | `rich` pages: Rich Markdown with a table from data (`md`), Rich HTML with details and a button inside the text, blocks with a photo |
| [`flowchart.ts`](../examples/flowchart.ts) | `app.flowchart()` and `mermaidLiveUrl`: a bot that sends its own map |
| [`cloudflare-worker.ts`](../examples/cloudflare-worker.ts) | a Cloudflare Worker: webhook, Redis over HTTP, cron for scheduled tasks |
| [`captcha.ts`](../examples/captcha.ts) | server-side answers, per-key session TTL, dialogues |
| [`notify.ts`](../examples/notify.ts) | SQLite storage, `stored` buttons, `sendLater` |
| [`locales/id.ts`](../examples/locales/id.ts) | translating built-in texts |
| [`testing.test.ts`](../examples/testing.test.ts) | testing with `easytg/testing` |

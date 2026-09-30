# Changelog

All notable changes are documented here. Add entries under **Unreleased**;
`bun run release` moves them under the new version (see [RELEASING.md](RELEASING.md)).

## Unreleased

## 0.3.1 (2026-09-30)

### Breaking

See [docs/migration.md](docs/migration.md).

- `verifyInitDataSignature` is async (it uses Web Crypto's Ed25519 now): `await verifyInitDataSignature(initData, botId)`.
- Node.js 20 or newer (`engines`). easytg uses the Web Crypto global (`crypto.randomUUID`, Ed25519) instead of `node:crypto`; Node 18 is past its end of life.

### Added

- **Runs in browsers.** No Node-only APIs are left: hashing and signing use pure JavaScript and Web Crypto, and `AsyncLocalStorage` is used only where it exists. Bundlers pick the browser build (`dist/browser/`) through the `browser` export condition. Callback data, signatures and deep links are byte-for-byte the same as before.
- **`easytg/simulator`:** `TelegramSimulator`, an in-memory Telegram for grammY bots: chats, groups and users; messages, edits and deletes; media and albums; inline and reply keyboards; toasts and alerts; inline mode; invoices and payments; chat actions; members and admins. It parses HTML and MarkdownV2 into entities and fails with Telegram's errors (`can't parse entities`, `message is not modified`, `bot was blocked by the user`, …). Works with `bot.handleUpdate` and with `bot.start()`. See [docs/simulator.md](docs/simulator.md).
- **`easytg/simulator/element`:** `<easytg-chat>` / `mountChat()`, a Telegram-like chat window for a simulator (light and dark).
- **`easytg preview <file>`** (CLI, needs Bun): your bot file, unchanged, against a simulated Telegram with a chat window in the browser; no token, nothing reaches Telegram. The bot restarts on file changes, the chat stays; the page shows its output and API calls. **Export test** turns what you did into a `bun test` file. See [docs/preview.md](docs/preview.md).
- **`easytg/simulator/load`:** `loadBot(file)` runs a bot file against a simulator in-process (for tests); `interceptBotApi(target)` sends grammY's calls to a simulator or another Bot API root.
- **Commands:** `app.command(names, pageOrDialogue, { description, chats, params })` and `app.syncCommands(bot)`, which sets Telegram's command menu per scope (all, private, groups) and per language. See [docs/commands.md](docs/commands.md).
- **Relays:** `app.relay.start / end / peer` connect two users who then talk through the bot (messages are copied, accounts stay hidden); `relay.filter` option; `relayMessage` and `relayEnd` events. See [docs/relay.md](docs/relay.md).
- **Serverless and edge:** `workerd` / `worker` export conditions (the browser build), a Cloudflare Worker example with Redis over HTTP and a Cron Trigger, and [docs/serverless.md](docs/serverless.md).
- Simulator: `sim.tap(label)`, `sim.handleRequest(request)` (the Bot API over HTTP, multipart and gzip included), `sim.notice(text)`, `sim.waitForPolling()`, `sim.commandsFor(chat, user)` with scoped and translated command lists, file downloads, `storeFile` option, "Clear history" and START in the chat window.
- Examples: `match.ts`, a swipe-style "meet people" bot (profile cards, ❤️ 💌 👎 💤 reactions, likes, matches and anonymous chats through a relay); `cloudflare-worker.ts`.
- **Docs site** (VitePress, `website/`) on GitHub Pages, with a playground on the home page, one for every browser-friendly example, and runnable blocks in the feature docs (```` ```ts playground ```` fences, which GitHub shows as plain code). `bun run docs:dev` / `docs:build`.

## 0.3.0 (2026-09-29)

A large release. **Breaking changes are listed first; see [docs/migration.md](docs/migration.md) for how to update.**

### Breaking

- **All durations are milliseconds.** `session.ttlSeconds` → `session.ttlMs`, `buttons.ttlSeconds` → `buttons.ttlMs`, `deepLinks.ttlSeconds` → `deepLinks.ttlMs`, `session.set(k, v, { ttlSeconds })` → `{ ttlMs }`, and a custom `StorageAdapter`'s `set(key, value, ttl)` now receives milliseconds (may be below one second).
- `retryAfter(error)` (seconds) → `retryAfterMs(error)` (ms); `isBlockedByUser` → `isChatUnreachable`.
- `app.limitUser`, `app.releaseUser` and `app.isLimited` return promises (limits can live in shared storage).
- While a user is limited, all their updates are dropped (not only interactions); payments still pass. `exempt` users are never counted, but manual limits apply to them. The rate-limit window is fixed, starting with the first interaction.
- `sequential` is on by default: one update per user and chat at a time (waits at most 8 s).
- The example `examples/storage/sqlite.ts` is replaced by the built-in `SqliteStorage`, which takes an open database: `new SqliteStorage(new Database('bot.sqlite'))` (same table, existing data stays readable).
- `verifyStorageAdapter(adapter, { keyPrefix, ttlMs })` takes options instead of a key prefix.
- `MemoryStorage` stores JSON like the real adapters: a `Date` comes back as a string, a `Map` as `{}`, and `set(key, undefined)` throws.
- Button params: `false` leaves the param out (was the truthy string `"false"`); `nav.startDialogue` params are strings like button params; `nav.redirect` / `nav.startDialogue` no longer take button options.
- Code spans and blocks keep backslashes (only `\\` and `` \` `` are escapes there): `` `\d+` `` shows `\d+`.
- Calling `onText`, `steps`, `onFinish` or `onCancel` twice throws.
- `app.cancelDialogue` reports `reason: 'app'` (was `'command'`); `DialogueCancelReason` adds `'app'` and `'timeout'`.
- `app.broadcast` sends up to 5 messages at once (`concurrency`, default 5).
- `dialogue()` without a type argument infers the answers from the steps; `Dialogue`'s first type argument defaults to `Auto` (was `Record<string, any>`).
- `texts.collectReceived` / `texts.collectLimit` receive the Done label (`({ total, done })`, `({ max, done })`); new `texts.adminOnly`, `texts.openWebApp`, `texts.expectWebApp`.
- Docs are one markdown file per feature under `docs/` (index: `docs/README.md`); `docs/guide.md` is gone.

### Added

- **Storage:** built-in `SqliteStorage` (`bun:sqlite` or `better-sqlite3`) and `RedisStorage` (any Redis client, no dependency), imported from `easytg`. `StorageAdapter` gains optional atomic `increment` and `setIfAbsent`; `verifyStorageAdapter` checks them, and `verifyTaskStore` checks task stores.
- **Several processes:** `cluster` shares rate limits, mutes, double-tap and busy checks, per-user ordering and queues through the storage.
- **i18n for your messages:** `i18n.messages`, `fallbackLocale`, `t()` / `t.md()` / `t.html()` with placeholders and plural forms (in renders, middlewares, dialogues, menus; `app.t(ctx)` elsewhere). `app.setLocale(ctx, locale)` for language pickers; the language is remembered for `sendTo`, `sendLater` and broadcasts. `pt_BR` and `pt-br` are the same.
- **Page text input:** `page.onText(handler, { mode, deleteInput })` for search boxes and the like.
- **Queues:** `queues` option, `app.queue(name, job, { ctx })`, `app.enterQueue(ctx, name)`, `perUser` / `maxWaiting` / `timeoutMs`, `QueueFullError`, `QueueTimeoutError`, `queueWait` event.
- **Scheduled tasks** saved in storage: `task<P>(id).run(fn)`, `app.schedule` (`delayMs`, `at`, `everyMs`, `id`, `botId`), `app.cancelTask`, `app.startScheduler(...bots)`, `app.runDueTasks(...bots)`, retries with backoff, `taskError` event. Helpers: `app.deleteLater(target, ids, { delayMs })`, `app.sendLater(target, page, { params, delayMs })`, `deleteAfterMs` and `refreshEveryMs` on page content, `app.broadcastLater(targets, page, options)` with the `broadcastBatch` event.
- **Payments:** `invoice` content, `nav.pay()`, `payments.preCheckout` / `payments.onSuccess`, `payment` event.
- **Inline mode:** `app.inlineResult(ctx, page, { params, title })` turns pages into inline query results with working buttons.
- **Validation with schemas:** `page.params(schema)` and a `schema` on text steps accept any Standard Schema (zod, valibot, arktype…).
- **Dialogue timeouts:** `dialogue(id).timeout(ms)` and `dialogues.timeoutMs`.
- **Sessions:** `app.chatSession(ctx)` for chat-wide state; typed keys by declaring `interface SessionData` in `declare module 'easytg'`; `session.version` + `session.migrate` for data migrations.
- **Groups:** `requireChatAdmin()` middleware.
- `app.answer(ctx, toast)` answers a button press early.
- **User sessions:** `app.userSession(ctx)` holds state that follows a user across all chats, next to the per-chat `session`. User and chat sessions merge per key when saved, so concurrent updates (the same user in two chats, two users in a group) don't lose each other's changes. The language from `setLocale` is kept per user.
- **Loading indicators:** `page(...).loading({ text, action, toast, afterMs })`, `dialogue(...).loading(...)` for a slow `onFinish`, a `loading` default for all pages, and `app.withLoading(ctx, job, options)` for handlers: a placeholder the result replaces, a repeated "typing…" action, or a toast.
- **Typed dialogue answers:** `dialogue('x').steps([...])` reads the answers type off the steps (ids, choice values, schema outputs; steps with `when` are optional), no generic needed. `dialogue<{ … }>()` still works; `Auto` types only the params.
- **Conditional steps:** `when(helpers)` on any step.
- **Mini Apps:** `verifyInitData` / `verifyInitDataSignature`, `miniAppLink`, `replyMenu.webApp` with the `webAppData` event, a `webApp` dialogue step, `app.answerWebAppQuery`, `app.prepareShare`, and `app.withUser` to act for a user outside an update (also for webhooks).
- **Throttling:** `app.throttle(options)` API transformer keeps outgoing messages within Telegram's limits (30/s overall, 20/min per group by default, own rules per chat), shared across processes with `cluster`.
- `autoRetry()` API transformer that waits out 429s on every call; `isTransient(error)`.
- `media.cacheFileIds`: photos, videos, animations, documents and audio sent by URL are sent by their file id next time (kept `media.cacheTtlMs`, default 30 days).
- `page.params(parse)` may be async; `withContext()` also returns `task`.
- `update` event with `durationMs` and `outcome`; `pageView` has `chatId`, `userId` and `durationMs`; dialogue events have `params`.
- `app` in dialogue step helpers and `onFinish` / `onCancel`.
- Docs: API reference (`docs/app.md`), migration guide, inline mode, Mini Apps, groups, scaling, queues, scheduler, payments, text input.
- Examples: `search.ts`, `queue.ts`, `reminders.ts`, `payments.ts`, `production.ts`, `inline.ts`, `group.ts`, `sessions.ts`, `loading.ts`, `throttle.ts`, `mini-app.ts`; `notify.ts` and `course.ts` use the scheduler; `broadcast.ts` runs broadcasts in the background.

### Fixed

- `app.edit` deleted the target message (and sent nothing) when the page needed several messages, an album, a copy or an invoice.
- A keyboard-only render on a long (split) message deleted its earlier parts.
- `sendTo` / `edit` / `broadcast` for a user whose update was being handled overwrote each other's session changes.
- Menus with `allowedUsers` became single-user after the first press.
- Pages shown by a dialogue's `onFinish` / `onCancel` or by a middleware redirect weren't recorded (no Back, no `onText`, no `pageView`).
- `collect` steps lost their Done button after an error, and a failed `validate` left the user stuck.
- `nav.close()` left the page's text input active.
- Re-entering a queue from the same update waited forever.
- A broadcast retrying a 429 resent the parts of a long page that had gone out already.
- MarkdownV2 text could be split between a backslash and the character it escapes; splits could produce messages of only spaces.
- Code fences with languages like `c++`, `c#` or `objective-c` weren't recognised.
- Scheduler: a task whose completion couldn't be saved ran again at once; one slow task held up all others; `stop()` then `start()` ran two poll loops; `deleteLater` didn't retry rate limits and network errors; `deleteAfterMs` deleted whatever page the message showed later.
- SQLite: `safeIntegers` databases returned bigint task fields; opening a new database from several processes at once could fail with "database is locked".
- Redis: `increment` extended the TTL of existing keys; task keys share a hash tag for Redis Cluster.
- Anti-spam: concurrent updates past the limit gave several `spam` events and strikes.
- Group menu ownership expired 7 days after sending, even while in use; nav history evicted menus by message id instead of by last use.
- `easytg/testing`: the fake API answered `sendChatAction` with a message instead of `true`.

## 0.2.1 (2026-09-28)

- `emitProactiveErrors` option: errors of `sendTo` and `edit` are also emitted as `error` events (still thrown). The `error` event now has a `source`: `update`, `sendTo` or `edit`.
- Double-tap, busy and anti-spam state is kept per bot, so one app instance can serve several bots. `limitUser`, `releaseUser` and `isLimited` take an optional bot id (without it they cover every bot).
- No "no user" warning for `sendTo` / `edit` to a group without a `userId`.
- The Release workflow explains how to fix a refused npm publish.

## 0.2.0 (2026-09-27)

- **Breaking:** storage keys include the bot id (`session:<bot>:…`, `cb:<bot>:…`, `msgowner:<bot>:…`) so bots can share a storage. Set `scopeKeysByBot: false` to keep the 0.1 format.
- **Breaking:** button param names starting with `_` are reserved.
- Per-button delivery: `nav.button(…, { mode: 'send' })` keeps the pressed message; `buttons.mediaToText: 'keep'` keeps media messages.
- `copy` content (`copyMessage`) and `protectContent` (per page or app-wide).
- `app.edit(bot, { chatId, messageId }, page, params)` re-renders into an existing message.
- `sent` event with all message ids.
- `prepareProactive` hook for `sendTo` / `edit` / `broadcast` contexts; `allowedUsers` on proactive targets.
- `page(...).params(parse)` validates and converts params; `InvalidParamsError`.
- `buttons.params: 'signed'` with `buttons.secret`: forge-proof inline params without storage writes.
- Error helpers `isBlockedByUser`, `isMessageNotFound`, `retryAfter`.
- `replyMenu.close()`: a menu button that removes the menu.
- `keyboard` accepts falsy values; `nav.url` / `nav.webApp` reject URLs Telegram doesn't accept.
- Testing: `createTestBot({ botInfo })`; `copyMessage(s)` / `forwardMessage(s)` answered like Telegram.
- Fix: `sendTo` messages of every media type now go to the requested forum topic.
- Example `course.ts`.

- Main menu on the reply keyboard: `replyMenu`, `app.showMenu` / `app.hideMenu`.
- Dialogue steps `contact` and `location`, and `choice` with `reply: true`, using reply-keyboard buttons.
- `nav.back()`: back to the previous page of a menu message, with its params.
- Media: `video`, `animation`, `document`, `audio` and `album` besides `photo` (`ImageSource` is now `MediaSource`).
- `app.broadcast`: paced sends to many chats, with retries, blocked-user reporting, progress and cancellation.
- Events `pageView`, `dialogueStart`, `dialogueFinish`, `dialogueCancel`.
- Testing: `t.update(raw)`, `telegramError(description, { code, retryAfter })`, albums return one message per item.
- Examples: `shop.ts`, `media.ts`, `broadcast.ts`, `testing.test.ts`.

## 0.1.0 (2026-09-27)

First release, grown out of the original `telegram.ts` concept.

- Pages: `page<P>(id).use(...).render(...)` with type-checked navigation (`nav.button`, `nav.self`, `nav.redirect`); declared params must be strings.
- Middlewares guard page renders *and* dialogue starts (`target` is the page or dialogue); `dialogue(id).use(...)`.
- Options grouped by feature: `session`, `buttons`, `deepLinks`, `dialogues`, `antiSpam`, `i18n`.
- One page, any delivery: send, reply, or edit in place, including text ↔ photo transitions.
- Dialogues: `text`, `file`, `choice` and `collect` steps, validation, Back/Cancel, actions, `onFinish` / `onCancel`.
- Safe formatting: `md` / `html` tagged templates escape interpolated values; built-in Markdown dialect, no dependencies.
- Sessions saved once per update, per-key TTL (`session.set(k, v, { ttlSeconds })`), session TTL refreshed by activity; pluggable `StorageAdapter` per concern, `keyPrefix`, SQLite example adapter.
- Button params inline, auto or stored server-side (`callbackParams`), with tamper-proof `stored` mode.
- `sendTo` for pages without an incoming update (notifications, cron, webhooks).
- Deep links: `nav.deepLink` / `app.deepLink`, opt-in per page with `.allowDeepLink()`.
- Per-user language for built-in texts (`locales`, `locale`); the library ships English only, see `examples/locales/id.ts` for a translation.
- Double-tap protection for buttons (`doubleTapMs`).
- Anti-spam rate limit per user (on by default), `spam` event with strikes, `limitUser` / `releaseUser`.
- Events: `app.on('spam' | 'error', …)`; `event.silence()` skips the default spam warning.
- Anti-spam only counts user interactions (`filter` to customise); payments and other service updates always pass.
- Long texts are split across messages (4096 / 1024 caption limits), tags kept balanced.
- Group menus can only be used by their owner (`restrictToOwner`).
- `easytg/testing`: fake Telegram API, `verifyStorageAdapter`.


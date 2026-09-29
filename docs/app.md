# API reference

Everything `easytg` exports, and every method of the app. Options are listed
in [Options](options.md). All durations are in milliseconds.

## Building blocks

| export | |
|---|---|
| `page<P>(id)` | a page: `.use(...)`, `.params(parse \| schema)`, `.allowDeepLink()`, `.render(fn)`, `.onText(fn, options)` — [Pages](pages.md) |
| `dialogue<A, P>(id)` | a multi-step form: `.use(...)`, `.steps(...)`, `.onFinish(...)`, `.onCancel(...)`, `.timeout(ms)`, `.allowBack()`, `.allowDeepLink()` — [Dialogues](dialogues.md) |
| `task<P>(id)` | a scheduled job: `.run(fn, { maxAttempts, retryDelayMs })` — [Scheduled tasks](scheduler.md) |
| `withContext<C>()` | `{ page, dialogue, task }` bound to your context type |
| `replyMenu(rows, options)` | a main menu on the reply keyboard — [Main menu](menu.md) |
| `md`, `html`, `escapeMarkdown`, `escapeHTML`, `escapeMarkdownV2` | [Text formatting](formatting.md) |
| `paginate(args, { total, perPage })` | page numbers for list pages |
| `requireChatAdmin(options)` | middleware: chat admins only — [Groups](groups.md) |
| `isProactive(ctx)` | whether a render comes from `sendTo` & co |
| `MemoryStorage`, `SqliteStorage`, `RedisStorage`, `withPrefix` | [Storage](storage.md) |
| `autoRetry(options)` | API transformer for 429s — [Error helpers](errors.md#autoretry) |
| `isChatUnreachable`, `isMessageNotFound`, `isTransient`, `retryAfterMs` | [Error helpers](errors.md) |
| `EasyTGError`, `InvalidParamsError`, `QueueFullError`, `QueueTimeoutError` | errors easytg throws |
| `easytg/testing` | `createTestBot`, `telegramError`, `verifyStorageAdapter`, `verifyTaskStore` — [Testing](testing.md) |

## `app` methods

### Setup

| method | |
|---|---|
| `new EasyTG(options)` | [Options](options.md) |
| `app.register(...items)` | pages, dialogues and tasks |
| `bot.use(app)` | handle updates; register before your own handlers |
| `app.on(event, listener)` | returns an unsubscribe function — [Events](events.md) |

### Showing pages

| method | |
|---|---|
| `app.open(ctx, page, params?, { mode })` | show a page for an update; returns the sent `Message`, `true` for an edited inline message, or `undefined` |
| `app.sendTo(bot, target, page, params?)` | send a page without an update — [Sending without an update](proactive.md) |
| `app.edit(bot, { chatId, messageId }, page, params?)` | re-render a page into an existing message; `undefined` if it can't be edited |
| `app.broadcast(bot, targets, page, options)` | paced sends to many chats |
| `app.broadcastLater(targets, page, options)` | the same, as scheduled tasks that survive restarts |
| `app.inlineResult(ctx, page, options)` | a page as an inline-mode result — [Inline mode](inline-mode.md) |
| `app.showMenu(ctx, text)` / `app.hideMenu(ctx, text)` | show or remove the main menu |
| `app.answer(ctx, toast?)` | answer a button press now (e.g. before slow work) |
| `app.nav(ctx)` | a `nav` outside renders |
| `app.deepLink(bot, target, params?, { store })` | a `t.me/…?start=` link |
| `app.hasPage(id)` | whether a page is registered |

### Dialogues

| method | |
|---|---|
| `app.startDialogue(ctx, dialogue, params?)` | start one (middlewares run first) |
| `app.cancelDialogue(ctx)` | cancel the active one (`reason: 'app'`); false if none |

### State and language

| method | |
|---|---|
| `app.session(ctx)` | the user's session — [Sessions](sessions.md) |
| `app.chatSession(ctx)` | the chat's shared session |
| `app.flush(ctx)` | save now (otherwise done at the end of the update) |
| `app.t(ctx \| locale)` | your messages in the user's (or a given) language — [Languages](i18n.md) |
| `app.setLocale(ctx, locale)` | set the user's language (`undefined`: automatic) |
| `app.localeOf(ctx)` | the user's language |
| `app.textsFor(ctx)` | easytg's built-in texts in the user's language |

### Limits, queues and tasks

| method | |
|---|---|
| `app.limitUser(userId, ms, botId?)` / `app.releaseUser(userId, botId?)` / `app.isLimited(userId, botId?)` | manual mutes — [Anti-spam](anti-spam.md) |
| `app.queue(name, job, { ctx })` / `app.enterQueue(ctx, name)` | concurrency limits — [Queues](queues.md) |
| `app.schedule(task, payload, options)` / `app.cancelTask(id)` | [Scheduled tasks](scheduler.md) |
| `app.deleteLater(target, messageIds, { delayMs })` | delete messages later |
| `app.sendLater(target, page, { params, delayMs })` | send a page later |
| `app.startScheduler(...bots)` | run due tasks; returns `stop()` |
| `app.runDueTasks(...bots)` | run what's due now, once (cron, tests) |

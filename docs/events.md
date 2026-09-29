# Events

```ts
const off = app.on('pageView', ({ ctx, page, params, mode }) => track(ctx.from?.id, page)); // returns an unsubscribe function
```

| event | payload | when |
|---|---|---|
| `update` | `{ ctx, durationMs, outcome }` | an update went through `bot.use(app)`. `outcome`: `easytg` (handled by a page, dialogue, menu…), `next` (passed to your handlers; the time includes them), `limited` / `busy` (dropped), `error` |
| `pageView` | `{ ctx, page, params, mode: 'send' \| 'edit', chatId?, userId?, durationMs }` | a page was shown (after redirects); `durationMs` covers render and delivery |
| `sent` | `{ ctx, chatId, messageIds, page? }` | new messages were sent: all ids of a split page or an album, e.g. to delete them later |
| `dialogueStart` | `{ ctx, dialogue, params }` | a dialogue started |
| `dialogueFinish` | `{ ctx, dialogue, params, answers }` | a dialogue was completed |
| `dialogueCancel` | `{ ctx, dialogue, params, answers, reason }` | `reason`: `user`, `command`, `replaced`, `app` or `timeout` (see [Dialogues](dialogues.md#ending-a-dialogue)) |
| `spam` | `SpamEvent` | see [Anti-spam](anti-spam.md) |
| `error` | `{ error, ctx, source: 'update' \| 'sendTo' \| 'edit' }` | an error while handling buttons, dialogue input, menu buttons, deep links, page text input or the `payments` handlers (`source: 'update'`), or in `sendTo` / `edit` with `emitProactiveErrors`; without a listener it is logged |
| `queueWait` | `{ ctx?, queue, position? }` | a job has to wait for a [queue](queues.md) slot |
| `taskError` | `{ error, task: { id, name, payload, attempts }, willRetry }` | a [scheduled task](scheduler.md) failed; without a listener it is logged |
| `payment` | `{ ctx, payment, payload }` | a [payment](payments.md) succeeded (with the `payments` option) |
| `webAppData` | `{ ctx, data, raw, button }` | a Mini App opened from `replyMenu.webApp` sent data; see [Mini Apps](mini-apps.md) |
| `broadcastBatch` | `{ broadcast, batch, batches, result }` | a batch of [`broadcastLater`](proactive.md#broadcasts-that-survive-restarts) was sent |

```ts
// Slow updates, e.g. for metrics:
app.on('update', ({ ctx, durationMs, outcome }) => durationMs > 1000 && log.warn(`slow ${outcome} update`, ctx.update.update_id));
```

Listeners run one after another and are awaited; an error thrown by a listener
is logged and doesn't stop the others.

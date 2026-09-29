# Scheduled tasks

Run code later: reminders, follow-ups, expiring messages, daily digests.
Tasks are saved in your storage, so they survive restarts and deploys, and
each task runs once even when several processes poll.

## Defining and scheduling

```ts
import { task } from 'easytg';

const remind = task<{ chatId: number; text: string }>('remind').run(async ({ payload, bot, app, task }) => {
  await bot.api.sendMessage(payload.chatId, `⏰ ${payload.text}`);
});

app.register(remind);

await app.schedule(remind, { chatId, text: 'Stand up!' }, { delayMs: 30 * 60_000 });
await app.schedule(remind, { chatId, text: 'Launch' }, { at: new Date('2026-12-01T09:00:00Z') });
```

The payload is typed and must be JSON-serializable. A task without payload is
`task('cleanup')` and is scheduled with `app.schedule(cleanup)`.

| `schedule` option | |
|---|---|
| `delayMs` / `at` | when to run (a `Date` or ms timestamp); default: now |
| `everyMs` | repeat every this many ms (at least 1000) after the first run |
| `id` | your own id; scheduling again with the same id replaces the task. Default: random |
| `botId` | the bot to run it with (`ctx.me.id`), when the scheduler serves several bots |

`app.schedule` returns the task id; `app.cancelTask(id)` removes the task
(false if it already ran or never existed).

```ts
// One digest per chat, every day; scheduling again moves it instead of adding another.
await app.schedule(digest, { chatId }, { at: tomorrow9am, everyMs: 24 * 3600_000, id: `digest:${chatId}` });
```

## Running tasks

```ts
const stop = app.startScheduler(bot); // several bots: app.startScheduler(bot1, bot2)
// on shutdown:
await stop(); // waits for running tasks
```

The scheduler looks for due tasks every `pollMs` and runs them with the bot
they were scheduled for (the `botId` option; `deleteLater(ctx, …)` and
`deleteAfterMs` set it for you), else with the first bot. A task for a bot
this process doesn't run, or without a registered handler, is left for another
process and looked at again 30 s later. Up to `batchSize` tasks run at once;
a slow task doesn't hold up the others. Tasks that were due
while the bot was down run right after the start; a recurring task skips the
runs it missed. The scheduler keeps the process alive until `stop()`.

On serverless platforms, call `await app.runDueTasks(bot)` from a cron job
instead.

```ts
new EasyTG({
  scheduler: {
    pollMs: 1000,        // how often to look for due tasks
    batchSize: 20,       // tasks running at once
    leaseMs: 300_000,    // a task still running after this is started again elsewhere
    maxAttempts: 5,      // runs before a failing task is dropped
    retryDelayMs: (attempt) => Math.min(10_000 * 2 ** (attempt - 1), 3_600_000),
    store: undefined,    // TaskStore; default: `storage`
  },
});
```

`task(id).run(fn, { maxAttempts, retryDelayMs })` overrides the retry settings
for one task.

## Failures

A task that throws is retried after `retryDelayMs(attempt)`, up to
`maxAttempts` runs. Each failure emits `taskError`:

```ts
app.on('taskError', ({ error, task, willRetry }) => log.error(`task ${task.name} (${task.id}) failed`, error));
```

Without a listener, failures are logged. `task.attempts` in the handler tells
which run it is (1 on the first).

Tasks run at least once. In rare cases they run twice (a process dies, or the
storage fails, after the work but before it is recorded; a task runs longer
than `leaseMs`), so make handlers safe to repeat where it matters, e.g. check
whether a reminder was already sent.

## Built-in helpers

```ts
// Delete messages later (a captcha, a "wrong answer" note, a temporary video).
const note = await ctx.reply('Wrong code, try again.');
await app.deleteLater(ctx, note.message_id, { delayMs: 10_000 });
await app.deleteLater({ chatId, botId }, [id1, id2], { at: tomorrow });

// The same for page content: the page's message(s).
page('otp').render(() => ({ text: 'Your code: 1234', deleteAfterMs: 5 * 60_000 }));

// Send a page later, like sendTo (rendered when it is sent, in the user's language).
await app.sendLater(userId, lessonReminder, { params: { lesson: '2' }, delayMs: 24 * 3600_000, botId: bot.botInfo.id });

// Render a page into its message again, as long as it shows that page: a live status.
page('status').render(() => ({ text: statusText(), refreshEveryMs: 30_000 }));
```

- `deleteAfterMs` follows the message: if another page is shown in it
  before the time is up, that page's own `deleteAfterMs` replaces the
  deletion, or it is cancelled.
- `refreshEveryMs` (at least 5000) stops as soon as the message shows another
  page (whoever navigated it) or is deleted. Refreshes keep the menu's
  `allowedUsers`, and don't push back a pending `deleteAfterMs`.
- Messages that are already gone, and users who blocked the bot, are skipped
  without retries; rate limits and network errors are retried.
- A `sendLater` page that was only partly sent (a long page split in several
  messages) isn't retried, so no part arrives twice.
- For a newsletter that must survive restarts, see
  [`broadcastLater`](proactive.md#broadcasts-that-survive-restarts).

These helpers need a running scheduler too.

## Storage

Tasks are kept in a `TaskStore`. `MemoryStorage`, `SqliteStorage` and
`RedisStorage` all implement it, and `storage` is used by default. With
`MemoryStorage` tasks are lost on restart, so use SQLite or Redis in
production. Tasks aren't namespaced by `keyPrefix`: give separate apps their
own `new SqliteStorage(db, { table })` or `new RedisStorage(run, { prefix })`. A custom
`TaskStore` is checked with `verifyTaskStore` from `easytg/testing`; see
[Storage](storage.md#scheduled-tasks).

## Testing

`app.runDueTasks(bot)` runs what is due now. Move the clock with Bun's
`setSystemTime` to test later tasks, see [Testing](testing.md#scheduled-tasks).

[`examples/reminders.ts`](../examples/reminders.ts) is a complete reminder bot,
and [`examples/notify.ts`](../examples/notify.ts) uses `sendLater`.

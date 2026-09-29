# Queues

Limit how many slow jobs run at the same time (AI models, video rendering,
exports, calls to a rate-limited API), and let the rest wait in line.

```ts
const app = new EasyTG({
  queues: {
    ai: { concurrency: 2 },                                       // 2 at a time
    export: { concurrency: 1, perUser: 1, maxWaiting: 50, timeoutMs: 120_000 },
  },
});
```

| option | |
|---|---|
| `concurrency` | jobs running at the same time (across processes with [`cluster`](scaling.md)) |
| `perUser` | running or waiting jobs per user; more are rejected with `QueueFullError` (`reason: 'perUser'`). Needs `ctx` |
| `maxWaiting` | waiting jobs (per process); more are rejected with `QueueFullError` (`reason: 'maxWaiting'`) |
| `timeoutMs` | give up waiting after this long with `QueueTimeoutError` |

## Running a job

`app.queue(name, job, { ctx })` waits for a free slot, runs `job`, frees the
slot (also when `job` throws) and returns what `job` returned. Use it anywhere:
in renders, dialogues, handlers or background code.

```ts
const answer = page('answer').render(async ({ ctx, app }) => {
  const text = await app.queue('ai', () => askModel('…'), { ctx });
  return { text, parseMode: 'plain' };
});
```

In a handler, `app.enterQueue(ctx, name)` takes a slot for the rest of the
update: it is freed after your handlers finished.

```ts
bot.command('ask', async (ctx) => {
  await app.enterQueue(ctx, 'ai');
  await ctx.reply(await askModel(ctx.match));
}); // slot freed here
```

## Telling users they wait

The `queueWait` event fires once for a job that has to wait. `position` is 1
for the next in line (undefined with `cluster`, where the line spans processes):

```ts
app.on('queueWait', async ({ ctx, queue, position }) => {
  if (ctx?.chat) await ctx.api.sendMessage(ctx.chat.id, `⏳ You are number ${position ?? '?'} in the queue…`);
});
```

## Rejections

```ts
import { QueueFullError, QueueTimeoutError } from 'easytg';

try {
  await app.queue('ai', job, { ctx });
} catch (error) {
  if (error instanceof QueueFullError) await ctx.reply(error.reason === 'perUser' ? 'One at a time, please.' : 'Too busy, try later.');
  else if (error instanceof QueueTimeoutError) await ctx.reply('That took too long.');
  else throw error;
}
```

## Things to know

- Code that already holds a slot of a queue (after `enterQueue` in that
  update, or inside an `app.queue` job) doesn't wait for a second one: nested
  calls just run. Jobs started side by side (`Promise.all`) each wait for
  their own slot.
- A job waiting in a queue keeps its update open, so the same user's next
  updates wait too ([sequential updates](scaling.md#sequential-updates)); a
  button they press gets the "Please wait" toast.
- With grammY's `bot.start()` updates are handled one at a time anyway: use
  webhooks or `@grammyjs/runner` to run jobs of different users in parallel.
- A job that must survive restarts, or that can run later, fits a
  [scheduled task](scheduler.md) better.

[`examples/queue.ts`](../examples/queue.ts) is a complete bot with both styles.

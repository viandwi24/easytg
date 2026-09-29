# Scaling and concurrency

A bot usually starts as one process with `bot.start()`. That handles one update
at a time, for all users, so one slow handler (an AI call, a big export)
stalls everyone. This page covers running updates concurrently and running
several processes.

## Sequential updates

With webhooks or [`@grammyjs/runner`](https://grammy.dev/plugins/runner),
updates are handled concurrently. easytg keeps each user's updates in order:
per user and chat, one update is handled at a time (`sequential`, on by
default). This prevents lost writes, e.g. two album photos sent to a `collect`
step both loading the session and one of them overwriting the other.

- Different users are never blocked by each other.
- A button pressed while the user's previous update still runs gets the
  "⏳ Please wait…" toast (see [double taps](anti-spam.md#double-taps-and-busy-buttons)).
- Other updates wait up to `timeoutMs` (default 8 000), then run anyway.
- Updates of a user who is [rate-limited](anti-spam.md) are dropped without waiting.
- The lock covers your own handlers registered after `bot.use(app)` too.

```ts
new EasyTG({ sequential: { timeoutMs: 8_000 } }); // or `sequential: false`
```

With webhooks, Telegram sends an update again when it isn't answered in time
(grammY's webhook timeout is 10 s by default), which is why the default wait
is 8 s. Keep handlers short there: long work belongs in a [queue](queues.md)
(with runner) or a [scheduled task](scheduler.md).

## Several processes (`cluster`)

To run the bot as several processes or on several machines, give them a shared
storage and turn on `cluster`:

```ts
import { RedisClient } from 'bun';
import { EasyTG, RedisStorage } from 'easytg';

const redis = new RedisClient(process.env.REDIS_URL);
const app = new EasyTG({
  storage: new RedisStorage((command, args) => redis.send(command, args)),
  cluster: true, // or: cluster: anotherAdapter
});
```

Then these are shared through the storage instead of kept per process:

| | |
|---|---|
| [anti-spam](anti-spam.md) | counters, limits, `limitUser` / `releaseUser` / `isLimited` |
| double taps and busy buttons | the last press and the "in progress" lock per user |
| [sequential updates](#sequential-updates) | a user is handled by one process at a time |
| [queues](queues.md) | `concurrency` counts jobs in all processes |

Sessions, buttons and deep links always live in the storage, and
[scheduled tasks](scheduler.md) are claimed atomically, so every process can
run `app.startScheduler(bot)`: each task still runs once.

`cluster` needs a storage with the atomic operations `increment` and
`setIfAbsent`. [`RedisStorage` and `SqliteStorage`](storage.md) have them; a
custom adapter can add them. SQLite works for processes on one machine; use
Redis across machines.

Locks and queue slots are held with a TTL that is refreshed while they are in
use, so a crashed process doesn't block users forever.

## Webhooks

```ts
import { webhookCallback } from 'grammy';

Bun.serve({ port: 8080, fetch: webhookCallback(bot, 'bun', { secretToken: process.env.WEBHOOK_SECRET }) });
await bot.api.setWebhook('https://bot.example.com', { secret_token: process.env.WEBHOOK_SECRET });
```

[`examples/production.ts`](../examples/production.ts) puts it together:
Redis or SQLite, `cluster`, webhooks or long polling, the scheduler, and
logging of errors and spam.

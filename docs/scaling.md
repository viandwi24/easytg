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

- Only messages and button presses are ordered this way; inline queries,
  member updates and the like aren't.
- Different users are never blocked by each other.
- A button pressed while the user's previous update still runs gets the
  "⏳ Please wait…" toast (see [double taps](anti-spam.md#double-taps-and-busy-buttons)).
- Other updates wait up to `timeoutMs` (default 8 000), then run anyway.
- Updates of a user who is [rate-limited](anti-spam.md) are dropped without waiting.
- The lock covers your own handlers registered after `bot.use(app)` too.

```ts
new EasyTG({ sequential: { timeoutMs: 8_000 } }); // or `sequential: false`
```

With `sequential: false`, updates run in parallel, but a button pressed while
the same user's previous press still runs still gets the "Please wait" toast.

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

## Staying within Telegram's limits

Telegram allows a bot about 30 messages per second overall and 20 per minute
in a group; beyond that it answers 429 "Too Many Requests". `app.throttle()`
spaces the bot's outgoing messages so that doesn't happen, and
[`autoRetry`](errors.md#autoretry) waits out the 429s that still come:

```ts
bot.api.config.use(autoRetry());
bot.api.config.use(app.throttle());                      // 30/s overall, 20/min per group

bot.api.config.use(app.throttle({
  global: { limit: 25, perMs: 1000 },
  groupChat: { limit: 20, perMs: 60_000 },
  privateChat: { limit: 1, perMs: 1000 },               // default: none
  chat: (chatId) => (chatId === ANNOUNCEMENTS ? { limit: 5, perMs: 60_000 } : undefined),
  maxWaitMs: 60_000,                                    // then it goes out anyway
}));
```

- Limited calls: sending, copying, forwarding and editing messages (an album
  counts one per item); `methods` changes that. Chat actions, answers to
  button presses and everything else are never delayed.
- `chat(chatId)` returns your own rule for a chat, `false` for no limit, or
  `undefined` for the defaults.
- Messages to a chat keep their order: calls that wait are served first come,
  first served (within a process; with `cluster`, processes take turns
  through the shared counters).
- The counters live where rate limits do: in this process, or shared by all
  processes with `cluster`. Several bots on one shared storage need their own
  `id` (e.g. the bot's username).
- A delayed call keeps its update waiting, so with webhooks keep the limits
  loose enough for replies (broadcasts are paced on their own).

[`examples/throttle.ts`](../examples/throttle.ts) is a commented setup with
rules per chat.

## Webhooks

```ts
import { webhookCallback } from 'grammy';

Bun.serve({ port: 8080, fetch: webhookCallback(bot, 'bun', { secretToken: process.env.WEBHOOK_SECRET }) });
await bot.api.setWebhook('https://bot.example.com', { secret_token: process.env.WEBHOOK_SECRET });
```

### Try it

Telegram's rate limits are on in this simulator. Pick the group at the top of
the chat and send /start there, then /burst: without a throttle, messages
after the 20th of the minute get `429 Too Many Requests` (see the API calls
tab). Uncomment the `app.throttle` line and press Run: they are spaced out
instead.

```ts playground group limits
import { Bot } from 'grammy';
import { EasyTG } from 'easytg';

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG();
// bot.api.config.use(app.throttle({ groupChat: { limit: 5, perMs: 10_000 } }));
bot.use(app);

bot.command('burst', async (ctx) => {
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => ctx.reply(`Message ${i + 1}`)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`${25 - failed} sent, ${failed} refused with 429`);
});
bot.command('start', (ctx) => ctx.reply('Send /burst.'));
bot.start();
```

On serverless and edge platforms (Cloudflare Workers, Deno Deploy, Vercel),
see [Serverless and edge](serverless.md).

[`examples/production.ts`](../examples/production.ts) puts it together:
Redis or SQLite, `cluster`, webhooks or long polling, the scheduler, and
logging of errors and spam.

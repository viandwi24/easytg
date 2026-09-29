# Storage

Everything easytg persists (sessions, dialogue state, stored buttons, message
metadata, scheduled tasks, and with [`cluster`](scaling.md) rate limits and
locks) goes through one small interface. Use a built-in adapter or plug in any
database.

## Built-in adapters

All import from `easytg`, with no extra dependencies:

| adapter | for | notes |
|---|---|---|
| `MemoryStorage` | development and tests (the default) | lost on restart, one process only; stores JSON like the others, so tests catch values that wouldn't survive a real store |
| `SqliteStorage` | one machine, one or several processes | pass a `bun:sqlite` or `better-sqlite3` database |
| `RedisStorage` | several processes or machines | pass a function that runs a Redis command with your client |

```ts
import { Database } from 'bun:sqlite';        // Node: import Database from 'better-sqlite3'
import { EasyTG, SqliteStorage } from 'easytg';

const storage = new SqliteStorage(new Database('bot.sqlite'));   // tables easytg_kv and easytg_tasks
const app = new EasyTG({ storage });
setInterval(() => storage.purgeExpired(), 3600_000);              // optional: reclaim space
```

```ts
import { RedisClient } from 'bun';
import { EasyTG, RedisStorage } from 'easytg';

const redis = new RedisClient(process.env.REDIS_URL);
const storage = new RedisStorage((command, args) => redis.send(command, args), { prefix: 'shopbot:' });

// ioredis:    new RedisStorage((command, args) => redis.call(command, ...args))
// node-redis: new RedisStorage((command, args) => client.sendCommand([command, ...args]))
```

`RedisStorage` works with Redis-compatible servers (Valkey, KeyDB, Dragonfly)
that support Lua scripts. `SqliteStorage({ table })` and
`RedisStorage({ prefix })` namespace the data, e.g. for two bots in one
database.

## What is stored where

| data | keys | option | lifetime |
|---|---|---|---|
| sessions (incl. dialogue state) | `session:<bot>:<chat>:<user>` | `session.storage` | `session.ttlMs` (default: none) |
| chat sessions | `chatsession:<bot>:<chat>` | `session.storage` | `session.ttlMs` |
| stored button params | `cb:<bot>:<token>` | `buttons.storage` | `buttons.ttlMs` (default 30 days) |
| stored deep-link params | `dl:<token>` | `buttons.storage` | `deepLinks.ttlMs` (default 365 days) |
| cached file ids (`media.cacheFileIds`) | `fileid:<bot>:…` | `buttons.storage` | `media.cacheTtlMs` (default 30 days) |
| group menu owners, split messages | `msgowner:<bot>:…`, `msggroup:<bot>:…` | `buttons.storage` | 7 days |
| rate limits, double taps, locks, queue slots | `spam:…`, `press:…`, `lock:…`, `queue:…` | `cluster` | seconds |
| scheduled tasks | a `TaskStore` (see below) | `scheduler.store` | until they ran |

`<bot>` is the bot's id, so several bots can share one storage without mixing
their data. Deep links are not tied to a bot, so a stored link keeps working
when you switch to another bot. `scopeKeysByBot: false` drops the bot id, which
is the 0.1 key format; set it when upgrading a 0.1 bot so its data stays
readable.

Everything falls back to `storage`. You can split it, e.g. sessions in your
main database and short-lived button data in Redis:

```ts
new EasyTG({
  storage: new SqliteStorage(new Database('bot.sqlite')),
  buttons: { storage: redisStorage },
  keyPrefix: 'shopbot:', // prefix of every key, when several bots share a database
});
```

## Your own adapter

```ts
interface StorageAdapter {
  get(key: string): Promise<unknown>;                              // the value, or null/undefined
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;

  // Optional, atomic; needed for `cluster`:
  increment?(key: string, by: number, ttlMs?: number): Promise<number>;
  setIfAbsent?(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
}
```

- `get` returns the value as it was given to `set` (an object, not a JSON
  string). Values are JSON-serializable.
- TTLs are in milliseconds and can be shorter than a second (rate-limit
  windows are short): with Redis use `PX`, not `EX`.
- easytg never stores `undefined` (it deletes the key instead); the built-in
  adapters reject it.
- `increment` adds to a number (missing or expired = 0) and returns the
  result; the TTL applies when the key is created.
- `setIfAbsent` sets a key only if it doesn't exist or has expired, and says
  whether it did.
- `withPrefix(adapter, prefix)` namespaces an adapter.

Check an implementation with `verifyStorageAdapter` from `easytg/testing`. It
also checks `increment` and `setIfAbsent` when present, including under
concurrency:

```ts
import { verifyStorageAdapter } from 'easytg/testing';

await verifyStorageAdapter(myAdapter);                         // throws on the first mismatch
await verifyStorageAdapter(myAdapter, { ttlMs: 200 });         // faster: TTLs below a second must work anyway
```

## Scheduled tasks

[Scheduled tasks](scheduler.md) need a `TaskStore`, a small queue sorted by due
time. The built-in adapters implement it; by default `storage` is used when it
does, else pass `scheduler: { store }`.

```ts
interface TaskStore {
  saveTask(task: StoredTask): Promise<void>;                                 // insert or replace by id
  claimTasks(now: number, limit: number, leaseMs: number): Promise<StoredTask[]>;
  finishTask(claimed: StoredTask, next?: StoredTask): Promise<void>;
  deleteTask(id: string): Promise<boolean>;
}
```

`claimTasks` must be atomic: it returns due tasks, earliest first, and moves
their `runAt` to `now + leaseMs` so no other process claims them meanwhile.
`finishTask` deletes the task (or saves `next`, a retry or the next run) only
if it wasn't claimed again since. `verifyTaskStore(store)` from
`easytg/testing` checks an implementation.

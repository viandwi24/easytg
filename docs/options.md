# Options

Every option of `new EasyTG(...)`, with its default. All durations are in
milliseconds.

```ts
new EasyTG<MyContext>({
  storage: new MemoryStorage(),    // default for everything easytg persists (see storage.md)
  keyPrefix: '',
  parseMode: 'markdown',           // 'markdown' | 'html' | 'markdownv2' | 'plain'
  homePage: 'home',                // page id used by nav.home()
  middlewares: [],                 // run before every page render and dialogue start
  logger: console,                 // warnings and errors; a Logger, or false for none; EASYTG_DEBUG=1 adds debug logs
  menu: undefined,                 // replyMenu([...])
  protectContent: false,           // protect_content on everything
  scopeKeysByBot: true,            // bot id in storage keys; false = 0.1 key format
  prepareProactive: undefined,     // (ctx) => … for contexts easytg creates (sendTo, edit, broadcast, tasks, withUser…)
  emitProactiveErrors: false,      // also emit sendTo / edit errors as 'error' events
  sequential: { timeoutMs: 8_000 },// one update per user and chat at a time; or false
  cluster: false,                  // true / a StorageAdapter: share limits, locks and queues between processes
  queues: {},                      // { name: { concurrency, perUser?, maxWaiting?, timeoutMs? } }
  loading: undefined,              // { afterMs, action, text, toast } for every page
  payments: undefined,             // { preCheckout?, onSuccess? }

  session:   { storage, ttlMs: undefined, refreshOnActivity: true, version: undefined, migrate: undefined },
  buttons:   { storage, params: 'auto', secret, ttlMs: 30 days, doubleTapMs: 700, ownerOnly: true, mediaToText: 'replace' },
  deepLinks: { ttlMs: 365 days },
  dialogues: { cancelOnCommand: true, timeoutMs: undefined },
  media:     { cacheFileIds: false, cacheTtlMs: 30 days },
  antiSpam:  { limit: 20, windowMs: 10_000, cooldownMs: 30_000, warn: true, exempt, filter }, // or false
  i18n:      { messages: {}, fallbackLocale: 'en', texts: {}, locales: {}, locale: (ctx, session) => ctx.from?.language_code },
  scheduler: { store, pollMs: 1000, batchSize: 20, leaseMs: 300_000, maxAttempts: 5, retryDelayMs },
});
```

| option | see |
|---|---|
| `storage`, `keyPrefix`, `scopeKeysByBot`, `session.storage`, `buttons.storage` | [Storage](storage.md) |
| `parseMode` | [Text formatting](formatting.md) |
| `homePage`, `middlewares` | [Pages](pages.md#nav), [middlewares](pages.md#middlewares) |
| `protectContent` | [Media](media.md) |
| `logger` | an object with `debug`, `info`, `warn` and `error` (e.g. pino or console); `false` silences easytg |
| `session` | [Sessions](sessions.md) |
| `loading` | [Pages](pages.md#slow-pages) |
| `media` | [Media](media.md#file-id-cache) |
| `buttons` | [Button params](button-params.md), [Pages](pages.md), [Anti-spam](anti-spam.md#double-taps-and-busy-buttons) |
| `deepLinks` | [Deep links](deep-links.md) |
| `dialogues` | [Dialogues](dialogues.md) |
| `menu` | [Main menu](menu.md) |
| `antiSpam` | [Anti-spam](anti-spam.md) |
| `sequential`, `cluster` | [Scaling](scaling.md) |
| `queues` | [Queues](queues.md) |
| `scheduler` | [Scheduled tasks](scheduler.md) |
| `payments` | [Payments](payments.md) |
| `i18n` | [Languages](i18n.md) |
| `prepareProactive`, `emitProactiveErrors` | [Sending without an update](proactive.md) |

With a custom grammY context type, bind the factories once:

```ts
export const { page, dialogue, task } = withContext<MyContext>();
```

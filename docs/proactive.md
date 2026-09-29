# Sending without an update

Use `sendTo` for notifications, cron jobs and payment webhooks:

```ts
await app.sendTo(bot, userId, orderShipped, { id: '42' });
await app.sendTo(bot, { chatId: groupId, userId, threadId }, report);
```

The page gets a minimal `ctx`: `api`, `chat` and `from`, with no message and no
properties added by your middlewares. `isProactive(ctx)` tells you which case
you are in. `session` is the recipient's normal session. `ctx.from` only
carries the user id, so keep names and preferences you need in the session.

- **Language:** the recipient's language is the one chosen with
  `app.setLocale`, else your `i18n.locale` function, else (with translations
  configured) the language their Telegram app had when they last wrote to the
  bot. See [Languages](i18n.md).
- **Session races:** called while an update of the same user is being handled
  (from that update's handler, a listener or a middleware, or from elsewhere
  in the same process), the page shares that update's session; otherwise it
  waits for the user's lock, so neither overwrites the other's changes.

`prepareProactive` adds what your middlewares normally put on `ctx`, for every
context easytg creates itself (`sendTo`, `edit`, `broadcast`, `sendLater`,
`broadcastLater`, `refreshEveryMs` re-renders, `withUser`,
`answerWebAppQuery`, `prepareShare`):

```ts
new EasyTG<MyContext>({
  prepareProactive: async (ctx) => {
    if (ctx.from) ctx.user = await loadUser(ctx.from.id);
  },
});
```

In groups, choose who may press the buttons of a proactive message.
`allowedUsers` is checked like menu ownership, even when `ownerOnly` is off:

```ts
await app.sendTo(bot, { chatId: reviewGroupId, userId: adminId, allowedUsers: adminIds }, reviewCard, { id });
```

To send a page later, even across restarts, use `app.sendLater` (a
[scheduled task](scheduler.md#built-in-helpers)):

```ts
await app.sendLater(userId, orderReminder, { params: { id: '42' }, delayMs: 3600_000 });
```

## Broadcast

Send a page to many chats. The sends are paced to Telegram's limits, and each
recipient gets their own render (their session, their language):

```ts
const result = await app.broadcast(bot, subscriberIds, newsPage, {
  params: { id: '42' },            // required if the page requires params
  perSecond: 25,                   // default 25 (Telegram allows about 30)
  concurrency: 5,                  // sends in flight at once; default 5
  onProgress: ({ total, sent, blocked, failed }) => { … },
  signal: controller.signal,       // AbortController to stop early
});
// { total, sent, blocked, failed, blockedChats, failures, aborted }
```

- "Too many requests" (429) answers are waited out (all sends pause) and
  retried, unless part of a long page had already gone out: that recipient
  counts as failed instead of getting the first part twice. With
  [`autoRetry`](errors.md#autoretry) installed, even that is retried safely.
- Users who blocked the bot or deleted their account end up in
  `blockedChats`. Remove them from your list.
- Other errors are collected in `failures` and don't stop the broadcast.
- A broadcast takes a while (1000 users at 25/s is 40 s): don't `await` it in
  an update handler, or the user (and with `bot.start()`, every user) waits.
- Pass ids in `params`, not long texts: params are stored in every
  recipient's navigation history.
- [`examples/broadcast.ts`](../examples/broadcast.ts) is a complete newsletter
  bot with an admin-only compose dialogue and live progress.

## Broadcasts that survive restarts

`app.broadcastLater` saves the broadcast as [scheduled tasks](scheduler.md),
one per batch of recipients, spaced to `perSecond`. Any process running
`startScheduler` sends them, and a restart only pauses it:

```ts
const { id, batches } = await app.broadcastLater(subscriberIds, newsPage, {
  params: { id: '42' },
  batchSize: 100,        // recipients per task; default 100
  perSecond: 25,
  delayMs: 60_000,       // or `at`
  botId: bot.botInfo.id, // with several bots
});

app.on('broadcastBatch', ({ broadcast, batch, batches, result }) => {
  // result: { sent, blocked, failed, blockedChats, failures, … } of this batch
});
```

A batch that fails as a whole isn't retried (it would send to its recipients
twice).

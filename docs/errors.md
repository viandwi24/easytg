# Errors

## When handling an update fails

When a page, dialogue, menu button or deep link throws while handling an
update, easytg tells the user (`texts.error`: an alert on a button press, a
reply to a message), emits the `error` [event](events.md) (or logs it when
nobody listens) and carries on. `errors` changes that:

```ts
new EasyTG({
  errors: {
    // Who is told: true (default), false, or per error.
    notify: ({ on }) => on === 'button',   // 'button' | 'message'
    // Throw the error on to grammY instead of the `error` event: bot.catch,
    // or your webhook / queue, which can retry the update.
    rethrow: true,
  },
});
```

With `rethrow`, the state the update changed before the error is still saved;
a dialogue whose `onFinish` failed keeps its answers. If your queue retries
updates, turn on [`dedupeUpdates`](scaling.md#updates-delivered-twice) so a
retried update that already got through isn't taken twice.

## Helpers

```ts
import { isChatUnreachable, isMessageNotFound, isTransient, retryAfterMs } from 'easytg';

isChatUnreachable(err);  // blocked / kicked / chat not found: the chat can't be messaged anymore
isMessageNotFound(err);  // the message to edit or delete is gone
isTransient(err);        // worth retrying later: 429, network failure, Telegram 5xx
retryAfterMs(err);       // ms to wait for 429 "Too Many Requests", else undefined
```

## autoRetry

An API transformer that waits out "Too Many Requests" (429) answers and tries
again, for every call the bot makes (pages, parts of long messages,
notifications, broadcasts). Install it once:

```ts
import { autoRetry } from 'easytg';

bot.api.config.use(autoRetry());
bot.api.config.use(autoRetry({ maxRetries: 5, maxDelayMs: 30_000, retryUnsure: true }));
```

- `maxRetries` (default 3) per call; a wait longer than `maxDelayMs` (default
  60 s) returns the error instead.
- `retryUnsure` (default off) also retries network failures and Telegram 5xx
  errors. Off by default because the request may have gone through, so a
  retried send could arrive twice.

It only reacts to 429s. To stay under the limits in the first place, use
[`app.throttle()`](scaling.md#staying-within-telegrams-limits).

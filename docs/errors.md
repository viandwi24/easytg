# Error helpers

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

It doesn't slow the bot down to stay under the limits; for that, see grammY's
[transformer-throttler](https://grammy.dev/plugins/transformer-throttler).

# Anti-spam

On by default: a user who makes more than **20 interactions in 10 seconds** is
ignored for **30 seconds**. While limited, their interactions don't reach easytg
*or* your handlers registered after `bot.use(app)`, so a flood costs the bot
next to nothing.

What counts towards the limit:
- button presses
- messages with content (text, media, stickers) in private chats
- `/commands` in groups

Other updates (inline queries, member updates, reactions, ordinary group
chatter) never count, but while a user is limited, **all** their updates are
dropped. Payments (`pre_checkout_query`, `successful_payment`) always go
through. Change what counts with `filter`; `exempt` users never count
(a manual `limitUser` still applies to them).

```ts
new EasyTG({
  antiSpam: {
    limit: 20,          // updates per window
    windowMs: 10_000,
    cooldownMs: 30_000,
    warn: true,         // toast on buttons / one reply in private chats; nothing in groups
    exempt: (ctx) => ADMINS.includes(ctx.from!.id),
    filter: (ctx) => !!ctx.callbackQuery, // e.g. only limit button presses
  },
  // antiSpam: false   // disable
});
```

The window starts with a user's first interaction and lasts `windowMs`.

## Reacting to spammers

The `spam` event fires when a user hits the limit. `strike` counts how often
the user was limited recently (it resets after 24 h without incidents):

```ts
app.on('spam', async ({ ctx, userId, chatId, strike, count, until, silence }) => {
  if (strike >= 3) {
    await app.limitUser(userId, 24 * 3600 * 1000);                          // ignore for a day
    if (chatId && chatId < 0) await ctx.api.banChatMember(chatId, userId);   // or ban from the group
    silence();                                                               // skip the default warning
  }
});
// await app.releaseUser(userId) in the listener lets the update through (e.g. log-only mode)
```

`app.limitUser(userId, ms)`, `app.releaseUser(userId)` and
`app.isLimited(userId)` also work with `antiSpam: false`, for manual mutes.
They return promises.

Limits are counted per bot, so one app instance can serve several bots. The
methods above take an optional bot id as their last argument; without it,
`limitUser` mutes the user on every bot and `releaseUser` / `isLimited` cover
every bot.

## Several processes

Counters, limits and mutes live in memory by default, per process. With
[`cluster`](scaling.md), they are kept in your storage (Redis, SQLite), so a
user flooding the bot is stopped whichever process receives their updates, and
`limitUser` in one process applies in all of them.

## Double taps and busy buttons

- A second press of the same button that arrives right after the first one
  finished (within `buttons.doubleTapMs`, default 700 ms) is ignored.
- A press while an earlier update of the same user is still being handled gets
  a "⏳ Please wait…" toast (`texts.busy`) and is dropped.

Other updates of a user wait for the previous one instead, see
[sequential updates](scaling.md#sequential-updates). Both checks are shared
between processes with `cluster`.

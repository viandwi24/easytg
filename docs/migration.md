# Migrating

## 0.3 → 0.4

Two small breaking changes, both from easytg dropping Node-only APIs so it
also runs in browsers.

- **`verifyInitDataSignature` returns a promise.** It checks Telegram's
  Ed25519 signature with Web Crypto, which is async: add `await`.

  ```ts
  const init = verifyInitDataSignature(initData, botId);        // 0.3
  const init = await verifyInitDataSignature(initData, botId);  // 0.4
  ```

  TypeScript points you to every call whose result is used directly.
  `verifyInitData` (with the bot token) stays synchronous.
- **Node.js 20 or newer.** easytg uses the global `crypto` (Web Crypto) for
  random ids and Ed25519. Bun and Deno are unaffected.

Nothing stored changes: signed buttons, stored button params, deep links and
file id cache keys are computed exactly as before, so buttons in old messages
keep working.

## 0.2 → 0.3

0.3 adds a lot (storage adapters, scheduled tasks, queues, i18n, payments,
several processes) and makes the API more consistent, which breaks a few
things. Most of them are type errors, so TypeScript points you to them.

### Durations are milliseconds everywhere

| 0.2 | 0.3 |
|---|---|
| `session: { ttlSeconds: 3600 }` | `session: { ttlMs: 3600_000 }` |
| `buttons: { ttlSeconds }`, `deepLinks: { ttlSeconds }` | `buttons: { ttlMs }`, `deepLinks: { ttlMs }` |
| `session.set(key, value, { ttlSeconds: 300 })` | `session.set(key, value, { ttlMs: 300_000 })` |
| `retryAfter(error)` (seconds) | `retryAfterMs(error)` (ms) |

**Custom storage adapters:** the third argument of `set` is now a TTL in
milliseconds (it was seconds), and may be below one second. Convert it where
you pass it to your database (Redis: `PX` instead of `EX`), then run
`verifyStorageAdapter(adapter, { ttlMs: 200 })`, which now takes options
`{ keyPrefix?, ttlMs? }` instead of a key-prefix string. (The one duration
still in seconds is `telegramError(…, { retryAfter })` in `easytg/testing`,
because it mirrors Telegram's `retry_after` field.)

### Renamed

| 0.2 | 0.3 |
|---|---|
| `isBlockedByUser(error)` | `isChatUnreachable(error)` |
| `examples/storage/sqlite.ts` (copy) | `SqliteStorage` from `easytg`, taking an open database: `new SqliteStorage(new Database('bot.sqlite'))`. Same table, your data stays readable. |

### Changed behaviour

- **`limitUser`, `releaseUser`, `isLimited` return promises** (limits can live
  in a shared storage): `await app.isLimited(id)`.
- **A limited user's updates are all dropped**, not only the ones that count
  towards the limit (group chatter, inline queries…). Payments still pass.
  `exempt` users are never counted, but a manual `limitUser` now applies to
  them too. The rate-limit window starts with the first interaction (it was
  sliding).
- **Updates of one user are handled one at a time** (`sequential`, on by
  default, waits at most 8 s). Set `sequential: false` for the 0.2 behaviour.
- **Button params:** `false` leaves the param out (it arrived as the truthy
  string `"false"`). `nav.startDialogue(d, { id: 42 })` passes `"42"`, like a
  button does. `nav.redirect` and `nav.startDialogue` no longer accept button
  options as a third argument (they were ignored).
- **`MemoryStorage` stores JSON**, like SQLite and Redis: a `Date` in a
  session comes back as a string, a `Map` as `{}`, and `set(key, undefined)`
  throws. Tests now catch what production would break on.
- **Code keeps its backslashes:** in `` `code` `` and code blocks only `\\` and
  `` \` `` are escapes, so `` `\d+` `` shows `\d+` (0.2 removed the backslash).
- **Defining a handler twice throws:** `onText`, `steps`, `onFinish` and
  `onCancel` (like `render` already did).
- **`dialogueCancel` reasons:** `app.cancelDialogue` now reports `'app'` (was
  `'command'`), and dialogues with a timeout report `'timeout'`. Update
  exhaustive `switch`es over `reason`.
- **`dialogue()` without a type argument** now infers the answers from the
  steps. Code that relied on `answers` being `any` may now see precise types
  (and catch misspellings); steps built in a loop stay untyped. If you
  annotate the `Dialogue` type yourself, its first type argument defaults to
  `Auto` now.
- **`easytg/testing`:** the fake API answers `sendChatAction` with `true`, so
  chat actions no longer use up message ids; tests that assert exact message
  ids may shift.
- **`app.broadcast`** sends up to 5 messages at once (`concurrency`), so
  recipients aren't served strictly in list order. `concurrency: 1` restores
  the 0.2 behaviour.

### Built-in texts

If you translate `EasyTGTexts` in full (like `examples/locales/id.ts`):

- add `adminOnly` (used by `requireChatAdmin`), `openWebApp` and `expectWebApp`
  (the `webApp` dialogue step);
- `collectReceived` and `collectLimit` receive the Done button's label:
  `collectReceived: ({ total, done }) => …`, `collectLimit: ({ max, done }) => …`
  (`collectLimit` took a number).

### Docs

`docs/guide.md` is split into one page per feature; start at
[docs/README.md](README.md).

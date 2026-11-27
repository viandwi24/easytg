# Migrating

## 0.5 → next

What you may notice:

- **Pages opened by a message are a new message, not a reply.** `app.open`
  (mode `auto`) used to quote the user's message (`/start` showed above the
  answer). For the old look: `app.open(ctx, page, params, { mode: 'reply' })`.
- **`nav.close()` sends `p|_ex`** instead of `p|exit`, and `exit` is no longer
  a reserved id. Close buttons already in chats keep working, unless you now
  register a page or dialogue called `exit` (then they open it).
- **Stored buttons last 365 days** instead of 30 (`buttons.ttlMs`).
- **`NODE_ENV=production` without `storage`** logs a warning at startup.
- **`EasyTGTexts.chooseAtLeast`, `chooseAtMost`, `expectNumber` and
  `expectDate` are required** in the type. Only a full `EasyTGTexts` object
  you build yourself needs them; `i18n.texts` and `i18n.locales` take partial
  texts as before.

Renamed or deprecated (the old names still work until 1.0):

| before | now |
|---|---|
| `middlewares: [...]` | `guards: [...]` (type `Guard`) |
| `easytg/simulator`, `…/load`, `…/element` | `@easytg/simulator`, `…/load`, `…/element` |
| `Collected.texts`, `Collected.files` | `Collected.items` |
| `scopeKeysByBot: false` | move 0.1 data to the current keys |

Two types grew:

- `Collected` has `items` (everything in order). Code that builds a
  `Collected` by hand, e.g. in tests, needs it: `{ texts, files, items: [] }`.
- `UpdateOutcome` has `duplicate` (only with `dedupeUpdates`). An exhaustive
  `switch` over it needs the new case.

## 0.4 → 0.5

Your bot's code doesn't change. What changes is how you install the tools
around it: the simulator and the preview are their own packages now, and a
bot in production no longer downloads them.

- **`easytg/simulator` needs `@easytg/simulator`.** easytg re-exports it but
  doesn't install it any more (it's only for tests, the playground and the
  studio). If you import `easytg/simulator`, `easytg/simulator/load` or
  `easytg/simulator/element`, add it as a dev dependency:

  ```bash
  bun add -d @easytg/simulator    # the same version as easytg
  ```

- **`easytg preview` runs easytg studio**, from `@easytg/studio`:

  ```bash
  bun add -d @easytg/studio @easytg/simulator
  bunx easytg preview src/bot.ts
  ```

  The studio has everything the preview had (Flow map, Export test, uploads)
  and more: profiles, groups, channels and topics made from the chat window,
  and bots in any language (`easytg-studio --cmd "python bot.py"`). Changes:
  - The default port is 4646 (was 4545).
  - **Two chats** is gone: switch profiles at the bottom of the chat list
    instead, or open the page in two browser tabs.
  - Every Bot API call takes 120–280 ms, like a real network; `--latency 0`
    for instant answers.
  - Tests recorded with **Export test** import `@easytg/simulator`; tests
    recorded before keep working (with `@easytg/simulator` installed).

- **A message that can't be edited is replaced the other way round**: the
  new message is sent first, then the old one deleted (it used to be deleted
  first). Tests that check the exact order of API calls see
  `sendMessage`, then `deleteMessage` / `editMessageReplyMarkup`.

- **Dialogue `onFinish` runs before the prompt is cleared** and before
  `dialogueFinish` is emitted. If it throws, the dialogue and its answers
  stay (the next message tries again) instead of being gone.

Nothing stored changes.

## 0.3.0 → 0.3.1

Two small breaking changes, both from easytg dropping Node-only APIs so it
also runs in browsers.

- **`verifyInitDataSignature` returns a promise.** It checks Telegram's
  Ed25519 signature with Web Crypto, which is async: add `await`.

  ```ts
  const init = verifyInitDataSignature(initData, botId);        // 0.3.0
  const init = await verifyInitDataSignature(initData, botId);  // 0.3.1
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

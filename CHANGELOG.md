# Changelog

All notable changes are documented here. Add entries under **Unreleased**;
`bun run release` moves them under the new version (see [RELEASING.md](RELEASING.md)).

## Unreleased

- `emitProactiveErrors` option: errors of `sendTo` and `edit` are also emitted as `error` events (still thrown). The `error` event now has a `source`: `update`, `sendTo` or `edit`.
- Double-tap, busy and anti-spam state is kept per bot, so one app instance can serve several bots. `limitUser`, `releaseUser` and `isLimited` take an optional bot id (without it they cover every bot).
- No "no user" warning for `sendTo` / `edit` to a group without a `userId`.
- The Release workflow explains how to fix a refused npm publish.

## 0.2.0 (2026-09-27)

- **Breaking:** storage keys include the bot id (`session:<bot>:…`, `cb:<bot>:…`, `msgowner:<bot>:…`) so bots can share a storage. Set `scopeKeysByBot: false` to keep the 0.1 format.
- **Breaking:** button param names starting with `_` are reserved.
- Per-button delivery: `nav.button(…, { mode: 'send' })` keeps the pressed message; `buttons.mediaToText: 'keep'` keeps media messages.
- `copy` content (`copyMessage`) and `protectContent` (per page or app-wide).
- `app.edit(bot, { chatId, messageId }, page, params)` re-renders into an existing message.
- `sent` event with all message ids.
- `prepareProactive` hook for `sendTo` / `edit` / `broadcast` contexts; `allowedUsers` on proactive targets.
- `page(...).params(parse)` validates and converts params; `InvalidParamsError`.
- `buttons.params: 'signed'` with `buttons.secret`: forge-proof inline params without storage writes.
- Error helpers `isBlockedByUser`, `isMessageNotFound`, `retryAfter`.
- `replyMenu.close()`: a menu button that removes the menu.
- `keyboard` accepts falsy values; `nav.url` / `nav.webApp` reject URLs Telegram doesn't accept.
- Testing: `createTestBot({ botInfo })`; `copyMessage(s)` / `forwardMessage(s)` answered like Telegram.
- Fix: `sendTo` messages of every media type now go to the requested forum topic.
- Example `course.ts`.

- Main menu on the reply keyboard: `replyMenu`, `app.showMenu` / `app.hideMenu`.
- Dialogue steps `contact` and `location`, and `choice` with `reply: true`, using reply-keyboard buttons.
- `nav.back()`: back to the previous page of a menu message, with its params.
- Media: `video`, `animation`, `document`, `audio` and `album` besides `photo` (`ImageSource` is now `MediaSource`).
- `app.broadcast`: paced sends to many chats, with retries, blocked-user reporting, progress and cancellation.
- Events `pageView`, `dialogueStart`, `dialogueFinish`, `dialogueCancel`.
- Testing: `t.update(raw)`, `telegramError(description, { code, retryAfter })`, albums return one message per item.
- Examples: `shop.ts`, `media.ts`, `broadcast.ts`, `testing.test.ts`.

## 0.1.0 (2026-09-27)

First release, grown out of the original `telegram.ts` concept.

- Pages: `page<P>(id).use(...).render(...)` with type-checked navigation (`nav.button`, `nav.self`, `nav.redirect`); declared params must be strings.
- Middlewares guard page renders *and* dialogue starts (`target` is the page or dialogue); `dialogue(id).use(...)`.
- Options grouped by feature: `session`, `buttons`, `deepLinks`, `dialogues`, `antiSpam`, `i18n`.
- One page, any delivery: send, reply, or edit in place, including text ↔ photo transitions.
- Dialogues: `text`, `file`, `choice` and `collect` steps, validation, Back/Cancel, actions, `onFinish` / `onCancel`.
- Safe formatting: `md` / `html` tagged templates escape interpolated values; built-in Markdown dialect, no dependencies.
- Sessions saved once per update, per-key TTL (`session.set(k, v, { ttlSeconds })`), session TTL refreshed by activity; pluggable `StorageAdapter` per concern, `keyPrefix`, SQLite example adapter.
- Button params inline, auto or stored server-side (`callbackParams`), with tamper-proof `stored` mode.
- `sendTo` for pages without an incoming update (notifications, cron, webhooks).
- Deep links: `nav.deepLink` / `app.deepLink`, opt-in per page with `.allowDeepLink()`.
- Per-user language for built-in texts (`locales`, `locale`); the library ships English only, see `examples/locales/id.ts` for a translation.
- Double-tap protection for buttons (`doubleTapMs`).
- Anti-spam rate limit per user (on by default), `spam` event with strikes, `limitUser` / `releaseUser`.
- Events: `app.on('spam' | 'error', …)`; `event.silence()` skips the default spam warning.
- Anti-spam only counts user interactions (`filter` to customise); payments and other service updates always pass.
- Long texts are split across messages (4096 / 1024 caption limits), tags kept balanced.
- Group menus can only be used by their owner (`restrictToOwner`).
- `easytg/testing`: fake Telegram API, `verifyStorageAdapter`.


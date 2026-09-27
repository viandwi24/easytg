# Changelog

All notable changes are documented here. Add entries under **Unreleased**;
`bun run release` moves them under the new version (see [RELEASING.md](RELEASING.md)).

## Unreleased

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


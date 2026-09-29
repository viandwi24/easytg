# Security notes

- **Callback data is untrusted.**
  - Use `buttons: { params: 'stored' }` for tamper-proof params.
  - Guard pages *and dialogues* with middlewares.
  - Page ids can still be requested directly, so check authorization in a
    middleware.
  - Never put secrets or answers in buttons. Keep them in the session, as the
    captcha example does.
- Use `md`/`html` templates for user data.
- Dialogue `choice` values and control buttons are checked against the active
  dialogue, and buttons from an earlier run are rejected as stale.
- In groups, a menu can only be used by the user it was opened for
  (`buttons.ownerOnly`, default on).
- `photo` strings are always a `file_id` or URL. Local files need an explicit
  `new InputFile(path)`.
- `collect` steps are capped by `max` (default 50).

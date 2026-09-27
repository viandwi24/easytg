# easytg guide

The complete reference. New to easytg? Start with [Getting started](getting-started.md).

- [Pages](#pages)
- [Dialogues](#dialogues)
- [Text formatting](#text-formatting)
- [Sessions](#sessions)
- [Anti-spam](#anti-spam)
- [Events](#events)
- [Deep links](#deep-links)
- [Languages](#languages)
- [Sending without an update](#sending-without-an-update)
- [Storage](#storage)
- [Button params: inline or stored](#button-params-inline-or-stored)
- [Security notes](#security-notes)
- [Options](#options)
- [Testing your bot](#testing-your-bot)

## Pages

```ts
const order = page<{ id: string; tab?: string }>('order')
  .use(requireLogin) // page middlewares (optional)
  .render(async ({ params, session, nav, ctx, app, page }) => ({
    text: ['**Order**', `ID: ${params.id}`],   // a string, or lines
    photo: photoFileId,                         // optional: file_id, URL or InputFile
    keyboard: [
      [nav.self('Details', { tab: 'details' })],                     // same page, params changed
      [isAdmin && nav.button('Refund', refund, { id: params.id })],  // falsy entries are dropped
      [nav.home(), nav.close()],
    ],
    toast: 'Loaded',                            // toast on the pressed button
    linkPreview: false,
  }));
```

A render returns one of:
- **content**: `{ text, photo, keyboard, toast, linkPreview, parseMode }`
- **`nav.redirect(page, params)`**: show another page instead
- **`nav.startDialogue(dialogue, params)`**: start a dialogue; the menu is closed
- **nothing**: do nothing

### `nav`

| | |
|---|---|
| `nav.button(text, pageOrDialogue, params?, { store? })` | open a page or start a dialogue |
| `nav.self(text, params)` | re-open the current page with params merged |
| `nav.home(text?)` / `nav.close(text?)` | home page / delete the message |
| `nav.url(text, url)` / `nav.webApp(text, url)` | links |
| `nav.deepLink(pageOrDialogue, params?)` | `https://t.me/<bot>?start=…` URL (see [Deep links](#deep-links)) |
| `nav.data(target, params?)` | raw callback data for hand-built keyboards |
| `nav.redirect(...)` / `nav.startDialogue(...)` | render results |

Outside a render (e.g. in `bot.command`), get one with `app.nav(ctx)`.

### Showing pages

`app.open(ctx, page, params?, { mode? })`. `mode` is one of:

| mode | behaviour |
|---|---|
| `auto` (default) | `edit` for button presses, `reply` otherwise |
| `send` | new message |
| `reply` | new message replying to the triggering message |
| `edit` | edit the pressed message; falls back to `send` when it can't |

Text ↔ photo transitions are handled for you: edit media, edit caption, or
delete and resend. `message is not modified` is ignored.

### Long messages

Text longer than Telegram's limits (4096 characters, or 1024 for a photo
caption) is split across several messages. The keyboard goes on the last
message.
- Cuts happen at line breaks where possible.
- Formatting stays intact: a `<b>` open at a cut is closed and reopened.
- When such a page is edited, the whole group is replaced.
- When the page later fits in one message again, or is closed, the extra
  messages are deleted.
- Inline-mode messages (sent via `@yourbot query`) can't grow into several
  messages. Only the first part is shown there, and dialogues can't start from
  them because there is no chat to talk in.

### Double taps

A second press of the same button that arrives right after the first finished
(within `buttons.doubleTapMs`, default 700 ms) is ignored. So is any press while
another one from the same user is still running; that user gets a
"⏳ Please wait…" toast. This check runs in memory, per process.

### Middlewares

```ts
const requireLogin: Middleware = ({ target, session, nav }, next) =>
  target.id === 'login' || session.get('user') ? next() : nav.redirect(login);

new EasyTG({ middlewares: [requireLogin] });  // every page and dialogue, runs first
page('admin').use(adminOnly).render(...);      // one page
dialogue('broadcast').use(adminOnly).steps(...); // one dialogue
```

Middlewares run before a page renders **and before a dialogue starts**, however
it is started: button, deep link, `nav.startDialogue` or `app.startDialogue`.
`target` is the page or dialogue. Global middlewares also run for redirect
targets, so let the login page through as shown above. Redirect loops are
stopped after 5 hops.

## Dialogues

Multi-step forms:

```ts
const signup = dialogue<{ name: string; plan: 'free' | 'pro'; avatar?: DialogueFile }>('signup')
  .steps(({ answers }) => [
    { id: 'name', type: 'text', text: 'Your name?',
      validate: (name) => name.length >= 2 || 'Too short' },       // a string = error message
    { id: 'plan', type: 'choice', text: 'Plan?', columns: 2,
      options: [{ text: 'Free', value: 'free' }, { text: 'Pro', value: 'pro' }] },
    ...(answers.plan === 'pro'                                       // steps can depend on answers
      ? [{ id: 'avatar', type: 'file' as const, accept: ['photo' as const], text: 'Send a photo' }]
      : []),
  ])
  .onFinish(({ answers, nav }) => ({ text: md`Welcome ${answers.name}!`, keyboard: [[nav.home()]] }))
  .onCancel(({ nav }) => nav.redirect(home));   // optional

// start it from a button, from a render, or anywhere
nav.button('Sign up', signup);
return nav.startDialogue(signup);
await app.startDialogue(ctx, signup);
```

| step type | answer | notes |
|---|---|---|
| `text` | `string` | other message types get a hint |
| `file` | `DialogueFile` | `accept: ['photo', 'document', …]` |
| `choice` | option `value` | only listed values are accepted, so forged ones are rejected |
| `collect` | `{ texts, files }` | collected until the user presses Done; `min`, `max` (default 50), `accept` |

- `validate(value, helpers)` returns `true` or nothing for valid, `false` for
  invalid with the generic message, or a string for invalid with that message.
- `actions: [{ id, text, run }]` adds extra buttons such as "Resend code". They
  run without advancing, and a string returned from `run` is shown as a toast.
- The step `text` can be a function of `{ ctx, session, params, answers, nav }`.
- A Back button appears from step 2 (`.allowBack(false)` hides it). Cancel is
  always shown.
- Prompts, errors and acknowledgements are cleaned up as the user moves on.
- The dialogue state is removed when the dialogue finishes or is cancelled.
- A `/command` sent during a dialogue cancels it and still runs the command
  (`dialogues: { cancelOnCommand: false }` turns this off).

## Text formatting

Plain strings are parsed with the app's `parseMode`, which you can override per
content or per step:

| `parseMode` | meaning |
|---|---|
| `markdown` (default) | `**bold**` `*italic*` `_italic_` `__underline__` `~~strike~~` `\|\|spoiler\|\|` `` `code` `` ```` ```pre``` ```` `[text](url)` `> quote` `# heading` `- bullet` |
| `html` | raw Telegram HTML |
| `markdownv2` | raw Telegram MarkdownV2 |
| `plain` | no formatting |

The Markdown dialect is predictable:
- `_` inside words (`snake_case`, URLs) never becomes italic.
- Unmatched markers are shown as-is.
- `\` escapes the next character.

**Put user data in `md` / `html` templates.** They escape every interpolated
value, so a user named `[free](https://evil)` can't inject a link:

```ts
text: md`Hello **${user.name}**, you owe ${amount}`
text: html`Hello <b>${user.name}</b>`
text: [md`**${title}**`, 'a plain line follows parseMode']  // mixing is fine
```

`escapeMarkdown`, `escapeHTML` and `escapeMarkdownV2` are also available for
manual escaping.

## Sessions

`session` holds state per user per chat. Reads and writes are synchronous:

```ts
session.get<number>('count');
session.set('count', 1);
session.setMany({ a: 1, b: 2 });
session.delete('a', 'b');
session.has('a');
```

Changes are saved **once, at the end of the update**, however many times you
call `set`.
- Outside renders, get the session with `await app.session(ctx)`.
- Handlers registered after `bot.use(app)` are saved automatically.
- Anywhere else, call `await app.flush(ctx)`.

If you process updates concurrently (e.g. with `@grammyjs/runner`), use grammY's
`sequentialize` per chat/user so writes to the same session don't race.

### Expiry

```ts
session.set('otp', '123456', { ttlSeconds: 300 }); // this key disappears after 5 minutes
session.get('otp');                                 // undefined once expired

new EasyTG({ session: { ttlSeconds: 7 * 24 * 3600 } }); // whole session: 7 days after last activity
```

- **Per-key TTL** works with any storage adapter, because the expiry is stored
  inside the session.
- **Session TTL** is passed to your adapter's `set`. By default any
  interaction keeps the session alive (`refreshOnActivity: true`); to save
  writes, the expiry is refreshed once half of the TTL has passed. With
  `refreshOnActivity: false`, only changes extend it.
- Without `session.ttlSeconds`, sessions never expire.

## Anti-spam

On by default: a user who makes more than **20 interactions in 10 seconds** is
ignored for **30 seconds**. While limited, their interactions don't reach easytg
*or* your handlers registered after `bot.use(app)`.

What counts as an interaction (and gets dropped while limited):
- button presses
- messages with content (text, media, stickers) in private chats
- `/commands` in groups

Everything else never counts and is never dropped: payments
(`pre_checkout_query`, `successful_payment`), inline queries, member updates,
reactions, and ordinary group chatter. Change the scope with `filter`.

```ts
new EasyTG({
  antiSpam: {
    limit: 20,          // updates per window
    windowMs: 10_000,
    cooldownMs: 30_000,
    warn: true,         // toast on buttons / one reply in private chats; nothing in groups
    exempt: (ctx) => ADMINS.includes(ctx.from!.id),
    filter: (ctx) => !!ctx.callbackQuery, // e.g. only limit button presses (default: see below)
  },
  // antiSpam: false   // disable
});
```

React to spammers with the `spam` event. `strike` counts how often the user
was limited recently (it resets after 24 h without incidents):

```ts
app.on('spam', async ({ ctx, userId, chatId, strike, count, until }) => {
  if (strike >= 3) {
    app.limitUser(userId, 24 * 3600 * 1000);                      // ignore for a day
    if (chatId && chatId < 0) await ctx.api.banChatMember(chatId, userId); // or ban from the group
  }
});
// app.releaseUser(userId) in the listener lets the update through (e.g. log-only mode)
// event.silence() skips the default warning for this incident (e.g. after banning)
```

`app.limitUser(userId, ms)`, `app.releaseUser(userId)` and
`app.isLimited(userId)` also work with `antiSpam: false`, for manual mutes.
Counting happens in memory, per process.

## Events

```ts
const off = app.on('spam', (event) => { ... });   // returns an unsubscribe function
app.on('error', ({ error, ctx }) => { ... });   // errors while handling buttons, dialogue input, deep links
```

Without an `error` listener, errors are logged.

## Deep links

`t.me/<bot>?start=<payload>` links open a page or start a dialogue. Because
anyone can type a deep link, a target has to opt in:

```ts
const product = page<{ id: string }>('product').allowDeepLink().render(...);
const signup = dialogue('signup').allowDeepLink().steps(...).onFinish(...);

nav.deepLink(product, { id: '42' });                          // inside a render
await app.deepLink(bot, product, { id: '42' });               // anywhere else
// → https://t.me/your_bot?start=product… ; a param-less target gives ?start=signup
```

- Links aren't bound to a user, so they're meant for sharing.
- Params that don't fit the 64-character payload are stored server-side
  (`deepLinks.ttlSeconds`, default 365 days).
- In `stored` mode, params are always stored and crafted payloads are ignored.
- `/start` without a payload, or with a payload easytg doesn't recognise, goes
  to your own `/start` handler.
- Treat deep-link params like any user input.

## Languages

Built-in labels and messages (Home, Cancel, "Please wait…", …) follow the user's
language:

```ts
new EasyTG({
  i18n: {
    texts: { home: '🏠 Start' },            // override the built-in English texts
    locales: { id },                        // per language; 'id-ID' falls back to 'id'
    locale: (ctx, session) => session.get('lang') ?? ctx.from?.language_code, // optional
  },
});
```

easytg itself ships English only. Translations are yours to provide:
[`examples/locales/id.ts`](../examples/locales/id.ts) is a complete Indonesian
example (`import { id } from './locales/id'`).

Renders, step helpers and `onFinish`/`onCancel` receive `locale`, so you can
translate your own content too, with a plain object or any i18n library.

## Sending without an update

Use `sendTo` for notifications, cron jobs and payment webhooks:

```ts
await app.sendTo(bot, userId, orderShipped, { id: '42' });
await app.sendTo(bot, { chatId: groupId, userId, threadId }, report);
```

The page gets a minimal `ctx`: `api`, `chat` and `from`, with no message and no
properties added by your middlewares. `isProactive(ctx)` tells you which case
you are in. `session` is the recipient's normal session.

## Storage

Everything easytg persists goes through one small interface. Plug it into any
database:

```ts
interface StorageAdapter {
  get(key: string): Promise<unknown>;                              // the value, or null/undefined
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
```

| data | keys | option | lifetime |
|---|---|---|---|
| sessions (incl. dialogue state) | `session:<chat>:<user>` | `session.storage` | `session.ttlSeconds` (default: none) |
| stored button params | `cb:<token>` | `buttons.storage` | `buttons.ttlSeconds` (default 30 days) |
| stored deep-link params | `dl:<token>` | `buttons.storage` | `deepLinks.ttlSeconds` (default 365 days) |
| group menu owners, split messages | `msgowner:…`, `msggroup:…` | `buttons.storage` | 7 days |

Both fall back to `storage`, which defaults to `MemoryStorage` (for
development only). Sessions are the data you usually want in your database;
button metadata is short-lived and fits Redis well:

```ts
new EasyTG({
  storage: new SqliteStorage('bot.sqlite'),
  buttons: { storage: redisStorage },
  keyPrefix: 'shopbot:', // when several bots share a database
});
```

- [`examples/storage/sqlite.ts`](../examples/storage/sqlite.ts) is a complete
  adapter on `bun:sqlite`.
- `withPrefix(adapter, prefix)` namespaces a single adapter.
- `verifyStorageAdapter(adapter)` from `easytg/testing` checks your own
  implementation.

A Redis adapter (ioredis) looks like this:

```ts
const redisStorage = (redis: Redis): StorageAdapter => ({
  get: async (key) => JSON.parse((await redis.get(key)) ?? 'null'),
  set: async (key, value, ttl) => {
    ttl ? await redis.set(key, JSON.stringify(value), 'EX', ttl) : await redis.set(key, JSON.stringify(value));
  },
  delete: async (key) => void (await redis.del(key)),
});
```

## Button params: inline or stored

Telegram limits callback data to 64 bytes, and modified clients can forge it.
`buttons.params` decides where button params live:

| mode | callback data | forgeable | size |
|---|---|---|---|
| `inline` | `p\|order\|id=42` | yes | throws above 64 bytes |
| `auto` (default) | inline if it fits, else `s\|<token>` | inline ones | unlimited |
| `stored` | `s\|<token>` whenever there are params | no | unlimited |

A stored button saves `{ target, params, user }` and carries only a
16-character token.
- The token resolves only for the user the button was rendered for.
- Re-rendering the same button reuses its token.
- In `stored` mode, incoming inline params are rejected, so `p|order|id=999`
  sent by a modified client does nothing.
- Pass `{ store: true }` to store the params of a single button.

## Security notes

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

## Options

```ts
new EasyTG<MyContext>({
  storage: new MemoryStorage(),    // default for everything easytg persists
  keyPrefix: '',
  parseMode: 'markdown',           // 'markdown' | 'html' | 'markdownv2' | 'plain'
  homePage: 'home',                // page id used by nav.home()
  middlewares: [],                 // run before every page render and dialogue start
  logger: undefined,               // Logger | false; EASYTG_DEBUG=1 for debug logs

  session:   { storage, ttlSeconds: undefined, refreshOnActivity: true },
  buttons:   { storage, params: 'auto', ttlSeconds: 2592000, doubleTapMs: 700, ownerOnly: true },
  deepLinks: { ttlSeconds: 31536000 },
  dialogues: { cancelOnCommand: true },
  antiSpam:  { limit: 20, windowMs: 10_000, cooldownMs: 30_000, warn: true, exempt, filter }, // or false
  i18n:      { texts: {}, locales: {}, locale: (ctx, session) => ctx.from?.language_code },
});
```

With a custom grammY context type, bind the factories once:

```ts
export const { page, dialogue } = withContext<MyContext>();
```

## Testing your bot

`easytg/testing` runs your bot against a fake Telegram API, with no token and no
network:

```ts
import { createTestBot, telegramError } from 'easytg/testing';

const t = createTestBot();
t.bot.use(app);
t.bot.command('start', (ctx) => app.open(ctx, home));

await t.message('/start');
expect(t.find('sendMessage')[0].payload.text).toContain('Hi');
await t.press('p|order|id=42', { language: 'id' }); // also: userId, chatType: 'group', messageId
await t.update({ pre_checkout_query: { … } });          // any other update type
expect(t.methods()).toContain('editMessageText');

t.responders.editMessageText = () => telegramError('Bad Request: message to edit not found');
```

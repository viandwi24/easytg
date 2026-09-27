# easytg guide

The complete reference. New to easytg? Start with [Getting started](getting-started.md).

- [Pages](#pages)
- [Media](#media)
- [Main menu (reply keyboard)](#main-menu-reply-keyboard)
- [Dialogues](#dialogues)
- [Text formatting](#text-formatting)
- [Sessions](#sessions)
- [Anti-spam](#anti-spam)
- [Events](#events)
- [Deep links](#deep-links)
- [Languages](#languages)
- [Sending without an update](#sending-without-an-update)
- [Broadcast](#broadcast)
- [Storage](#storage)
- [Button params: inline or stored](#button-params-inline-or-stored)
- [Security notes](#security-notes)
- [Error helpers](#error-helpers)
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
      [nav.back(), nav.home(), nav.close()],                         // back: hidden when there's no history
    ],
    toast: 'Loaded',                            // toast on the pressed button
    linkPreview: false,
  }));
```

A render returns one of:
- **content**: `{ text, keyboard, toast, linkPreview, parseMode }` plus one of
  `photo`, `video`, `animation`, `document`, `audio` or `album` (see [Media](#media))
- **`nav.redirect(page, params)`**: show another page instead
- **`nav.startDialogue(dialogue, params)`**: start a dialogue; the menu is closed
- **nothing**: do nothing

### `nav`

| | |
|---|---|
| `nav.button(text, pageOrDialogue, params?, { store? })` | open a page or start a dialogue |
| `nav.self(text, params)` | re-open the current page with params merged |
| `nav.back(text?)` | the page this message showed before, with its params; `false` (hidden) when there is none |
| `nav.home(text?)` / `nav.close(text?)` | home page / delete the message |
| `nav.url(text, url)` / `nav.webApp(text, url)` | links: `http(s)://` or `tg://` only (Telegram rejects `mailto:`, `tel:`); Mini Apps need `https://` |
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

### Keeping the pressed message

A button normally replaces the message it is on. For messages the user should
keep, such as a video or a document under which you offer "Next" or "All
items", you have two options:

```ts
nav.button('📂 All lessons', lessonList, {}, { mode: 'send' }); // this button: new message, pressed one untouched
new EasyTG({ buttons: { mediaToText: 'keep' } });               // any media message: keep it, only remove its buttons
```

By default (`mediaToText: 'replace'`), a media message that turns into a
text-only page is deleted and the page is sent as a new message.

### Updating a message later

`app.edit` re-renders a page into an existing message without an incoming
update. Use it for status cards, dashboards or anything else that changes
elsewhere:

```ts
await app.edit(bot, { chatId, messageId }, orderCard, { id: '42' });
// returns undefined (and sends nothing) if the message is gone
```

Media messages get their caption updated. The target accepts the same fields
as `sendTo` (`userId`, `allowedUsers`).

### Validating params

Params arrive as strings from callback data and can't be trusted.
`.params(parse)` validates and converts them before render:

```ts
const toInt = (value?: string) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new InvalidParamsError(`not a number: ${value}`);
  return n;
};

const episode = page<{ id: string }>('episode')
  .params((raw) => ({ id: toInt(raw.id) }))
  .render(({ params }) => …);   // params.id: number

nav.button('Next', episode, { id: 5 });   // links still take the raw params
```

If `parse` throws, a button press answers "page not found" (no error event),
and `app.open` rejects with `InvalidParamsError`. Middlewares still see the
raw params.

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

### Back

`nav.back()` remembers the path per menu message: `home → list (page 3) → detail`,
then Back, Back returns to page 3 of the list, then to home. Re-opening the
same page with other params (pagination, filters) doesn't add a step. A freshly
sent message has no history, so `nav.back()` returns `false` and the button
disappears. The history lives in the session (the last 20 menu messages, 10
steps each).

## Media

A page (or dialogue step) can show one media item, with `text` as its caption:

```ts
{ photo: 'AgACAgIAAx…', text: 'A photo' }             // file_id
{ video: 'https://example.com/clip.mp4', text: '…' }  // URL
{ animation: gifFileId }                              // GIF / silent MP4
{ document: new InputFile(buffer, 'report.pdf') }     // generated or local file
{ audio: songFileId }
```

- Switching between pages edits the media in place (`editMessageMedia`); the
  same file only updates the caption.
- Captions longer than 1024 characters continue in a text message.
- Media → text-only pages replace the message.

**Copying** an existing message is often better than uploading: nothing is
re-uploaded, there is no "forwarded from" header, and the original can live in a
private channel the bot reads (a media library, an archive):

```ts
{
  copy: { fromChatId: -1001234567890, messageId: 42 },
  text: 'New caption',          // optional: without it the original caption stays
  protectContent: true,         // optional: no forwarding or saving
  keyboard: [[nav.button('Next', item, { n: 43 })]],
}
```

Copies can't be edited into an existing message, so they are always sent as
new messages. `protectContent` works on every kind of content, and
`new EasyTG({ protectContent: true })` turns it on for everything (pages can
still set `protectContent: false`).

**Albums** show 2–10 items as one group:

```ts
{
  album: [
    { type: 'photo', media: p1 },
    { type: 'photo', media: p2 },
    { type: 'video', media: v1 },
  ],
  text: 'Our bestsellers',
  keyboard: [[nav.back()]],
}
```

Telegram doesn't allow buttons on albums. With a `keyboard`, the text and
buttons follow in their own message; without one, `text` becomes the album
caption. Pressing a button under an album edits that message and deletes the
album.

## Main menu (reply keyboard)

A persistent menu on the keyboard below the input field:

```ts
import { replyMenu } from 'easytg';

const mainMenu = replyMenu(
  [
    [replyMenu.button('🛍 Catalog', catalog), replyMenu.button('🧾 Orders', orders)],
    [replyMenu.button((locale) => (locale === 'id' ? '💬 Bantuan' : '💬 Support'), support)],
    [replyMenu.close()], // "✖️ Close menu": removes the keyboard
  ],
  { placeholder: 'Choose from the menu' },
);

const app = new EasyTG({ menu: mainMenu });
bot.command('start', (ctx) => app.showMenu(ctx, 'Welcome!')); // sends a message with the menu
```

- A menu button sends its label as a message. easytg recognises it (in the
  user's language) and opens the page **as a new message**, or starts the
  dialogue. Middlewares run as usual.
- Targets can't require params, because reply buttons only send their label.
- Pressing a menu button during a dialogue leaves the dialogue, like a /command.
- A reply keyboard stays in the chat until the bot removes it, even after the
  bot stops, so offer a way out. `replyMenu.close(label?)` adds a button that
  removes the menu; Telegram needs a message for that, so it sends
  `texts.menuClosed`. `app.hideMenu(ctx, text)` does the same from code (e.g. a
  `/hide` command).
- `{ persistent: false }` lets users collapse the menu into the keyboard icon
  instead of always showing it.

A message carries either inline buttons or a reply keyboard, never both. So
pages keep their inline keyboards, and the menu is set by its own message.

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
| `contact` | `DialogueContact` | "📱 Share my contact" button; only the user's own number unless `allowOthers` |
| `location` | `DialogueLocation` | "📍 Share my location" button (`button` to relabel) |

`contact`, `location` and `choice` with `reply: true` put their buttons on
the **reply keyboard**, including Back and Cancel. When the dialogue moves on to
an inline step or ends, a short message ("👍 Got it.") puts the main menu back,
or removes the keyboard when there is no menu. These steps can't have
`actions`.

```ts
dialogue<{ size: string; phone: DialogueContact; where: DialogueLocation }>('checkout').steps([
  { id: 'size', type: 'choice', reply: true, columns: 4, text: 'Size?', options: sizes },
  { id: 'phone', type: 'contact', text: 'Your phone number?' },
  { id: 'where', type: 'location', text: 'Delivery address?' },
]);
```

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
const off = app.on('pageView', ({ ctx, page, params, mode }) => track(ctx.from?.id, page)); // returns an unsubscribe function
```

| event | payload | when |
|---|---|---|
| `pageView` | `{ ctx, page, params, mode: 'send' \| 'edit' }` | a page was shown (after redirects) |
| `sent` | `{ ctx, chatId, messageIds, page? }` | new messages were sent: all ids of a split page or an album, e.g. to delete them later |
| `dialogueStart` | `{ ctx, dialogue, params }` | a dialogue started |
| `dialogueFinish` | `{ ctx, dialogue, answers }` | a dialogue was completed |
| `dialogueCancel` | `{ ctx, dialogue, answers, reason }` | `reason`: `user` (Cancel), `command` (a /command or menu button), `replaced` (another dialogue started) |
| `spam` | `SpamEvent` | see [Anti-spam](#anti-spam) |
| `error` | `{ error, ctx }` | an error while handling buttons, dialogue input, menu buttons or deep links; without a listener it is logged |

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
you are in. `session` is the recipient's normal session. `ctx.from` only
carries the user id, so keep names and preferences you need in the session.

`prepareProactive` adds what your middlewares normally put on `ctx`, for every
context easytg creates itself (`sendTo`, `edit`, `broadcast`):

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

## Broadcast

Send a page to many chats. The sends are paced to Telegram's limits, and each
recipient gets their own render (their session, their language):

```ts
const result = await app.broadcast(bot, subscriberIds, newsPage, {
  params: { id: '42' },            // required if the page requires params
  perSecond: 25,                   // default 25 (Telegram allows about 30)
  onProgress: ({ total, sent, blocked, failed }) => { … },
  signal: controller.signal,       // AbortController to stop early
});
// { total, sent, blocked, failed, blockedChats, failures, aborted }
```

- "Too many requests" (429) answers are waited out and retried.
- Users who blocked the bot or deleted their account end up in
  `blockedChats`. Remove them from your list.
- Other errors are collected in `failures` and don't stop the broadcast.
- [`examples/broadcast.ts`](../examples/broadcast.ts) is a complete newsletter
  bot with an admin-only compose dialogue and live progress.

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
| sessions (incl. dialogue state) | `session:<bot>:<chat>:<user>` | `session.storage` | `session.ttlSeconds` (default: none) |
| stored button params | `cb:<bot>:<token>` | `buttons.storage` | `buttons.ttlSeconds` (default 30 days) |
| stored deep-link params | `dl:<token>` | `buttons.storage` | `deepLinks.ttlSeconds` (default 365 days) |
| group menu owners, split messages | `msgowner:<bot>:…`, `msggroup:<bot>:…` | `buttons.storage` | 7 days |

`<bot>` is the bot's id, so several bots can share one storage without mixing
their data. Deep links are not tied to a bot, so a stored link keeps working
when you switch to another bot. `scopeKeysByBot: false` drops the bot id, which
is the 0.1 key format; set it when upgrading a 0.1 bot so its data stays
readable.

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
| `signed` | `p\|order\|id=42&_s=<signature>` | no | inline 64 bytes (overflow is stored) |

A stored button saves `{ target, params, user }` and carries only a
16-character token.
- The token resolves only for the user the button was rendered for.
- Re-rendering the same button reuses its token.
- In `stored` mode, incoming inline params are rejected, so `p|order|id=999`
  sent by a modified client does nothing.
- Pass `{ store: true }` to store the params of a single button.

**Signed** buttons keep their params inline and add a short HMAC signature, so
they can't be forged and nothing is written to storage when you render:

```ts
new EasyTG({ buttons: { params: 'signed', secret: process.env.BUTTON_SECRET } }); // ≥ 16 characters
```

The signature covers the bot, the chat, the target, the params and, for
owner-only menus, the user. Deep links are signed too, but without a user or
bot, so they can be shared. Keep the secret stable: changing it invalidates the
buttons already in chats. Param names starting with `_` are reserved.

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

## Error helpers

```ts
import { isBlockedByUser, isMessageNotFound, retryAfter } from 'easytg';

isBlockedByUser(err);    // 403 / chat not found: the chat can't be messaged anymore
isMessageNotFound(err);  // the message to edit or delete is gone
retryAfter(err);         // seconds to wait for 429 "Too Many Requests", else undefined
```

## Options

```ts
new EasyTG<MyContext>({
  storage: new MemoryStorage(),    // default for everything easytg persists
  keyPrefix: '',
  parseMode: 'markdown',           // 'markdown' | 'html' | 'markdownv2' | 'plain'
  homePage: 'home',                // page id used by nav.home()
  middlewares: [],                 // run before every page render and dialogue start
  logger: undefined,               // Logger | false; EASYTG_DEBUG=1 for debug logs
  menu: undefined,                 // replyMenu([...])
  protectContent: false,           // protect_content on everything
  scopeKeysByBot: true,            // bot id in storage keys; false = 0.1 key format
  prepareProactive: undefined,     // (ctx) => … for sendTo / edit / broadcast contexts

  session:   { storage, ttlSeconds: undefined, refreshOnActivity: true },
  buttons:   { storage, params: 'auto', secret, ttlSeconds: 2592000, doubleTapMs: 700, ownerOnly: true, mediaToText: 'replace' },
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
expect(t.methods()).toContain('editMessageText');

// contact / location / files: pass the message fields in `extra`
await t.message('', { extra: { text: undefined, contact: { phone_number: '+62…', first_name: 'Ann', user_id: 7 } } });
await t.update({ pre_checkout_query: { … } });      // any other update type

t.responders.editMessageText = () => telegramError('Bad Request: message to edit not found');
t.responders.sendMessage = () => telegramError('Forbidden: bot was blocked by the user', { code: 403 });

createTestBot({ botInfo: { id: 2, username: 'second_bot' } }); // several bots, e.g. sharing one storage
```

The fake API answers `send*`, `copyMessage(s)` and `forwardMessage(s)` like
Telegram: albums return one message per item, and copies return
`{ message_id }`.

[`examples/testing.test.ts`](../examples/testing.test.ts) shows a complete setup:
- helpers to read the screen and press buttons by label,
- dialogues with contact sharing,
- simulated Telegram errors,
- broadcasts.

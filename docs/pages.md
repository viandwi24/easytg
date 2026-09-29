# Pages

```ts
const order = page<{ id: string; tab?: string }>('order')
  .use(requireLogin) // page middlewares (optional)
  .render(async ({ params, session, nav, t, locale, ctx, app, page }) => ({
    text: ['**Order**', `ID: ${params.id}`],   // a string, or lines
    photo: photoFileId,                         // optional: file_id, URL or InputFile
    keyboard: [
      [nav.self('Details', { tab: 'details' })],                     // same page, params changed
      [isAdmin && nav.button('Refund', refund, { id: params.id })],  // falsy entries are dropped
      [nav.back(), nav.home(), nav.close()],                         // back: hidden when there's no history
    ],
    toast: 'Loaded',                            // toast on the pressed button
    linkPreview: false,
    deleteAfterMs: undefined,                   // delete the message later (a scheduled task)
  }));
```

A render returns one of:
- **content**: `{ text, keyboard, toast, linkPreview, parseMode, protectContent, deleteAfterMs }`
  plus one of `photo`, `video`, `animation`, `document`, `audio`, `album`, `copy`
  (see [Media](media.md)) or `invoice` (see [Payments](payments.md))
- **`nav.redirect(page, params)`**: show another page instead
- **`nav.startDialogue(dialogue, params)`**: start a dialogue; the menu is closed
- **nothing**: do nothing

## `nav`

| | |
|---|---|
| `nav.button(text, pageOrDialogue, params?, { store? })` | open a page or start a dialogue |
| `nav.self(text, params)` | re-open the current page with params merged |
| `nav.back(text?)` | the page this message showed before, with its params; `false` (hidden) when there is none |
| `nav.home(text?)` / `nav.close(text?)` | home page / delete the message |
| `nav.pay(text)` | the Pay button of an [invoice](payments.md) |
| `nav.url(text, url)` / `nav.webApp(text, url)` | links: `http(s)://` or `tg://` only (Telegram rejects `mailto:`, `tel:`); Mini Apps need `https://` |
| `nav.deepLink(pageOrDialogue, params?)` | `https://t.me/<bot>?start=…` URL (see [Deep links](deep-links.md)) |
| `nav.data(target, params?)` | raw callback data for hand-built keyboards |
| `nav.redirect(...)` / `nav.startDialogue(...)` | render results |

Outside a render (e.g. in `bot.command`), get one with `app.nav(ctx)`.

## Showing pages

`app.open(ctx, page, params?, { mode? })`. `mode` is one of:

| mode | behaviour |
|---|---|
| `auto` (default) | `edit` for button presses, `reply` otherwise |
| `send` | new message |
| `reply` | new message replying to the triggering message |
| `edit` | edit the pressed message; falls back to `send` when it can't |

Text ↔ photo transitions are handled for you: edit media, edit caption, or
delete and resend. `message is not modified` is ignored.

## Keeping the pressed message

A button normally replaces the message it is on, including when the new page
is a copy, an album or too long for one message. For messages the user should
keep, such as a video or a document under which you offer "Next" or "All
items", you have two options:

```ts
nav.button('📂 All lessons', lessonList, {}, { mode: 'send' }); // this button: new message, pressed one untouched
new EasyTG({ buttons: { mediaToText: 'keep' } });               // any media message: keep it, only remove its buttons
```

By default (`mediaToText: 'replace'`), a media message that turns into a
text-only page is deleted and the page is sent as a new message.

## Updating a message later

`app.edit` re-renders a page into an existing message without an incoming
update. Use it for status cards, dashboards or anything else that changes
elsewhere:

```ts
await app.edit(bot, { chatId, messageId }, orderCard, { id: '42' });
// returns undefined (and sends nothing) if the message is gone
```

Media messages get their caption updated. The target accepts the same fields
as `sendTo` (`userId`, `allowedUsers`).

## Validating params

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

A [Standard Schema](https://standardschema.dev) (zod, valibot, arktype, …)
works too, and types `params` from its output:

```ts
page<{ id: string }>('episode')
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .render(({ params }) => …);   // params.id: number
```

If `parse` throws (or the schema rejects), a button press answers "page not
found" (no error event), and `app.open` rejects with `InvalidParamsError`.
Middlewares still see the raw params, and so does `paginate`.

Values passed to buttons are turned into strings; `null`, `undefined` and
`false` leave the param out (so `{ archived: false }` arrives as no
`archived`, not as the truthy string `"false"`).

## Long messages

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

## Middlewares

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

## Back

`nav.back()` remembers the path per menu message: `home → list (page 3) → detail`,
then Back, Back returns to page 3 of the list, then to home. Re-opening the
same page with other params (pagination, filters) doesn't add a step. A freshly
sent message has no history, so `nav.back()` returns `false` and the button
disappears. The history lives in the session (the last 20 menu messages, 10
steps each).

## Updating itself

`refreshEveryMs` renders the page into its message again and again (at least
every 5 s) for as long as the message shows it, e.g. a live status or a
scoreboard. It uses the [scheduler](scheduler.md#built-in-helpers).

```ts
page('status').render(() => ({ text: `Queue: ${queue.length} jobs`, refreshEveryMs: 10_000 }));
```

## Inline mode

Pages can also be sent as inline-mode results (`@yourbot query` in any chat),
see [Inline mode](inline-mode.md).

## Text input

A page can also take what the user types while it is shown, e.g. a search box:
`page(...).render(...).onText(({ text, nav }) => nav.redirect(search, { q: text }))`.
See [Text input](text-input.md).

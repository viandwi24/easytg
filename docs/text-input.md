# Text input on pages

A page can take what the user types while it is on screen: a search box, a
quick "reply with a number", a filter. For longer forms, use a
[dialogue](dialogues.md).

```ts
const search = page<{ q?: string }>('search')
  .render(({ params, nav }) => ({
    text: params.q ? results(params.q) : 'Type a product name.',
    keyboard: [[nav.home()]],
  }))
  .onText(({ text, nav }) => nav.redirect(search, { q: text }));
```

The handler gets everything a render gets (`ctx`, `params` of the page as it
was shown, `session`, `t`, `nav`, …) plus `text`, and returns what a render
returns: content, `nav.redirect(...)`, `nav.startDialogue(...)` or nothing.

## When text goes to the page

The **last page shown** to the user in that chat decides. Text goes to its
`onText` when:

- it is plain text, not a `/command`,
- it isn't a [main menu](menu.md) button,
- no [dialogue](dialogues.md) is active (a dialogue takes the text; starting
  one ends the page's text input),
- in groups, the message is a reply to the page's message.

Showing a page without `onText`, a `/command`, the menu's close button,
closing the page (`nav.close()`) or starting a dialogue ends it; showing the page again (Back, a button, a redirect) starts it again.
Otherwise the text goes to your own handlers as usual.

## Options

```ts
.onText(handler, {
  mode: 'edit',       // update the page's message in place; default 'send' (a new message)
  deleteInput: true,  // delete the user's message afterwards; default false
})
```

`mode: 'edit'` with `deleteInput: true` keeps a single message that changes as
the user types. If the page's message can't be edited anymore, a new one is
sent.

Treat `text` like any user input: limit its length, and put it in `md` /
`html` templates or `t.md` when you show it.

[`examples/search.ts`](../examples/search.ts) is a searchable catalog with
pagination, in two languages.

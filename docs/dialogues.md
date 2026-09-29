# Dialogues

Multi-step forms:

```ts
const signup = dialogue('signup')
  .steps([
    { id: 'name', type: 'text', text: 'Your name?',
      validate: (name) => name.length >= 2 || 'Too short' },       // a string = error message
    { id: 'plan', type: 'choice', text: 'Plan?', columns: 2,
      options: [{ text: 'Free', value: 'free' }, { text: 'Pro', value: 'pro' }] },
    { id: 'avatar', type: 'file', accept: ['photo'], text: 'Send a photo',
      when: ({ answers }) => answers.plan === 'pro' },             // asked only for Pro
  ])
  // answers: { name: string; plan: 'free' | 'pro'; avatar?: DialogueFile } — read off the steps
  .onFinish(({ answers, nav }) => ({ text: md`Welcome ${answers.name}!`, keyboard: [[nav.home()]] }))
  .onCancel(({ nav }) => nav.redirect(home));   // optional

// start it from a button, from a render, or anywhere
nav.button('Sign up', signup);
return nav.startDialogue(signup);
await app.startDialogue(ctx, signup);
```

| step type | answer | notes |
|---|---|---|
| `text` | `string`, or the output of `schema` | other message types get a hint |
| `file` | `DialogueFile` | `accept: ['photo', 'document', …]` |
| `choice` | option `value` | only listed values are accepted, so forged ones are rejected |
| `collect` | `{ texts, files }` | collected until the user presses Done; `min`, `max` (default 50), `accept`. A failed `validate` starts the step over |
| `contact` | `DialogueContact` | "📱 Share my contact" button; only the user's own number unless `allowOthers` |
| `location` | `DialogueLocation` | "📍 Share my location" button (`button` to relabel) |
| `webApp` | the data a [Mini App](mini-apps.md) sends (parsed JSON), or the output of `schema` | a button that opens `url`; private chats only |

`contact`, `location` and `choice` with `reply: true` put their buttons on
the **reply keyboard**, including Back and Cancel. When the dialogue moves on to
an inline step or ends, a short message ("👍 Got it.") puts the main menu back,
or removes the keyboard when there is no menu. These steps can't have
`actions`.

```ts
dialogue('checkout').steps([   // answers: { size, phone: DialogueContact, where: DialogueLocation }
  { id: 'size', type: 'choice', reply: true, columns: 4, text: 'Size?', options: sizes },
  { id: 'phone', type: 'contact', text: 'Your phone number?' },
  { id: 'where', type: 'location', text: 'Delivery address?' },
]);
```

- `validate(value, helpers)` returns `true` or nothing for valid, `false` for
  invalid with the generic message, or a string for invalid with that message.
- `schema` (text steps): a [Standard Schema](https://standardschema.dev) such
  as zod or valibot checks and converts the text; its first issue is the
  error message, and its output is the answer:
  `{ id: 'age', type: 'text', text: 'Age?', schema: z.coerce.number().int().min(18) }`.
- `actions: [{ id, text, run }]` adds extra buttons such as "Resend code". They
  run without advancing, and a string returned from `run` is shown as a toast.
- Every step can show media with its prompt (`photo`, `video`, …, like a
  page) and set its own `parseMode`. `contact`, `location` and `webApp`
  take a `button` label; `collect` takes `min` (default 1) and `max`
  (default 50).
- The step `text` can be a function of `{ ctx, session, locale, t, params, answers, nav, app }`,
  and `steps(...)` a function of `{ ctx, params, answers, t }` (see [Languages](i18n.md)).
- `when(helpers)` (any step) decides whether the step is asked, from the
  answers so far; it can be async.
- Params arrive as strings, however the dialogue was started (a button,
  `nav.startDialogue(d, { id: 42 })`, `app.startDialogue`).
- A Back button appears from step 2 (`.allowBack(false)` hides it). Cancel is
  always shown.
- Prompts, errors and acknowledgements are cleaned up as the user moves on.
- The dialogue state is removed when the dialogue finishes or is cancelled.
- A `/command` sent during a dialogue cancels it and still runs the command
  (`dialogues: { cancelOnCommand: false }` turns this off).
- `onFinish`'s result (content, a redirect, …) is sent as a new message.
- `.use(...middlewares)` guards the start (like [page middlewares](pages.md#middlewares)),
  `.allowDeepLink()` lets a [deep link](deep-links.md) start it, and
  `.loading(...)` shows a placeholder or "typing…" while a slow `onFinish`
  runs (see [slow pages](pages.md#slow-pages)).

## Typed answers

The answers `onFinish` gets are typed from the steps, with nothing written by
hand:

| step | answer type |
|---|---|
| `text` | `string`, or the output of its `schema` (`z.coerce.number()` → `number`) |
| `choice` | the union of its option values (`'free' \| 'pro'`) |
| `file`, `collect`, `contact`, `location` | `DialogueFile`, `Collected`, `DialogueContact`, `DialogueLocation` |
| `webApp` | the output of its `schema`, else `unknown` |
| any step with `when` | optional (it may be skipped) |

A misspelled answer (`answers.nmae`) is then a compile error. A few things
to know:

- Declare the dialogue in one chain (`dialogue('x').steps([...]).onFinish(...)`):
  the type flows along the chain.
- Conditional steps: use `when`. With a steps function, steps that only some
  branches return become optional too:
  `.steps(({ answers }) => answers.more ? [a, b] : [a])`. Don't spread
  conditional steps into an array (`...(cond ? [step] : [])`): their answers
  would be typed as always present.
- Steps built in a loop (ids that aren't literals) give untyped answers, as
  before.
- You can still declare the answers yourself: `dialogue<{ name: string }>('x')`.
  To type only the params and infer the answers: `dialogue<Auto, { ref: string }>('x')`
  (`Auto` from `easytg`).

## Timeouts

A dialogue nobody answers stays active: text typed days later would still be
taken as its answer. Give it a timeout:

```ts
dialogue('quiz').timeout(60_000).steps(...)       // this dialogue: 1 minute
new EasyTG({ dialogues: { timeoutMs: 15 * 60_000 } }); // all others: 15 minutes
```

When the user comes back after the timeout, the dialogue ends first:
`onCancel` runs (its result isn't shown), `dialogueCancel` fires with
`reason: 'timeout'`, and the message goes to your own handlers; old buttons
answer "no longer active".

## Ending a dialogue

`dialogueCancel` tells why a dialogue ended without finishing:

| `reason` | |
|---|---|
| `user` | the user pressed Cancel (`onCancel`'s result replaces the prompt) |
| `command` | a /command or a main-menu button took over |
| `replaced` | another dialogue started |
| `app` | your code called `app.cancelDialogue(ctx)` |
| `timeout` | nobody answered in time |

# Dialogues

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
| `text` | `string`, or the output of `schema` | other message types get a hint |
| `file` | `DialogueFile` | `accept: ['photo', 'document', …]` |
| `choice` | option `value` | only listed values are accepted, so forged ones are rejected |
| `collect` | `{ texts, files }` | collected until the user presses Done; `min`, `max` (default 50), `accept`. A failed `validate` starts the step over |
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
- `schema` (text steps): a [Standard Schema](https://standardschema.dev) such
  as zod or valibot checks and converts the text; its first issue is the
  error message, and its output is the answer:
  `{ id: 'age', type: 'text', text: 'Age?', schema: z.coerce.number().int().min(18) }`.
- `actions: [{ id, text, run }]` adds extra buttons such as "Resend code". They
  run without advancing, and a string returned from `run` is shown as a toast.
- The step `text` can be a function of `{ ctx, session, locale, t, params, answers, nav, app }`,
  and `steps(...)` a function of `{ ctx, params, answers, t }` (see [Languages](i18n.md)).
- Params arrive as strings, however the dialogue was started (a button,
  `nav.startDialogue(d, { id: 42 })`, `app.startDialogue`).
- A Back button appears from step 2 (`.allowBack(false)` hides it). Cancel is
  always shown.
- Prompts, errors and acknowledgements are cleaned up as the user moves on.
- The dialogue state is removed when the dialogue finishes or is cancelled.
- A `/command` sent during a dialogue cancels it and still runs the command
  (`dialogues: { cancelOnCommand: false }` turns this off).

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

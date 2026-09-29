# Deep links

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
  (`deepLinks.ttlMs`, default 365 days).
- In `stored` mode, params are always stored and crafted payloads are ignored.
- `/start` without a payload, or with a payload easytg doesn't recognise, goes
  to your own `/start` handler.
- Treat deep-link params like any user input.

# Sessions

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

Values are stored as JSON, in every storage (including the in-memory one used
in tests): a `Date` comes back as a string, a `Map` or `Set` as `{}`.

When updates are handled concurrently (webhooks, `@grammyjs/runner`), easytg
handles one update per user and chat at a time, so writes to the same session
don't race. See [sequential updates](scaling.md#sequential-updates). A page
sent with `sendTo` while the user's own update is running in the same process
shares that update's session.

## Typed keys

Declare your keys once to type `get` and `set`:

```ts
declare module 'easytg' {
  interface SessionData {
    cart: string[];
    plan: 'free' | 'pro';
  }
}

session.get('cart');          // string[] | undefined
session.set('plan', 'gold');  // type error
session.get<number>('other'); // undeclared keys stay free-form
```

## Expiry

All durations in easytg are in milliseconds.

```ts
session.set('otp', '123456', { ttlMs: 5 * 60_000 });  // this key disappears after 5 minutes
session.get('otp');                                     // undefined once expired

new EasyTG({ session: { ttlMs: 7 * 24 * 3600_000 } }); // whole session: 7 days after last activity
```

- **Per-key TTL** works with any storage adapter, because the expiry is stored
  inside the session.
- **Session TTL** is passed to your adapter's `set`. By default any
  interaction keeps the session alive (`refreshOnActivity: true`); to save
  writes, the expiry is refreshed once half of the TTL has passed. With
  `refreshOnActivity: false`, only changes extend it.
- Without `session.ttlMs`, sessions never expire.

## Chat sessions

State shared by everyone in a chat (a group's settings, a game board) lives in
the chat session, next to each user's own session:

```ts
const chat = await app.chatSession(ctx);
chat.set('settings', { quizzes: false });
```

It is loaded once per update and saved with the user's session. Updates of
different users can run at the same time, so two users changing the same key
at once can overwrite each other: for counters that many users update, use an
atomic store (e.g. `storage.increment`).

## Migrations

When the shape of your session data changes, give it a version and convert
old sessions as they are loaded:

```ts
new EasyTG({
  session: {
    version: 2,
    migrate: (data, fromVersion) => {
      if (fromVersion < 2) data.cart = typeof data.cart === 'string' ? [data.cart] : [];
      return data;
    },
  },
});
```

`fromVersion` is 0 for data stored before you set a version. Each session (and
chat session) is migrated once, the next time it is loaded; new sessions start
at the current version.

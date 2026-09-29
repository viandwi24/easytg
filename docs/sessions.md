# Sessions

`session` holds your state per user **in the current chat**: the private
chat and each group have their own. For state that follows a user
everywhere, there is the [user session](#per-chat-and-per-user). Reads and
writes are synchronous:

```ts
session.get<number>('count');
session.set('count', 1);
session.setMany({ a: 1, b: 2 });
session.delete('a', 'b');
session.has('a');
session.keys();       // the keys that are set
session.toJSON();     // all values
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

## Per chat and per user

Three kinds of session, all saved once at the end of the update:

| | holds | key |
|---|---|---|
| `session` (render / dialogue argument, `app.session(ctx)`) | the user **in this chat**: a form in progress, a filter, the page they are on | `session:<bot>:<chat>:<user>` |
| `app.userSession(ctx)` | the user **in every chat**: a plan, a cart, settings | `usersession:<bot>:<user>` |
| `app.chatSession(ctx)` | the chat, **shared by its users**: a group's settings, a game board | `chatsession:<bot>:<chat>` |

```ts
page('plan').render(async ({ ctx, app, session }) => {
  const user = await app.userSession(ctx);          // the same in private and in groups
  const plan = user.get<string>('plan') ?? 'free';
  session.set('lastViewed', 'plan');                // only in this chat
  return { text: `Your plan: ${plan}` };
});
```

- easytg's own state (active dialogues, Back history, page text input) lives
  in `session`, so a dialogue started in a group isn't answered from the
  private chat.
- The user and chat sessions can be changed by several updates at once (the
  same user in two chats, two users in a group). When saved, only the keys
  this update changed are written over what is stored, so changes to other
  keys aren't lost. Two updates changing the *same* key at once: the last one
  wins; for counters, use an atomic store (`storage.increment`).
- A language chosen with `setLocale` is kept in the user session, so it
  applies in every chat.

### Try it

Press the buttons, then switch to the group at the top of the chat (and to
another user) and press them there.

```ts playground group
import { Bot } from 'grammy';
import { EasyTG, page } from 'easytg';

const counters = page('counters').render(async ({ ctx, app, session, nav }) => {
  const user = await app.userSession(ctx);
  const chat = await app.chatSession(ctx);
  return {
    text: [
      `session (you, in this chat): ${session.get<number>('n') ?? 0}`,
      `userSession (you, everywhere): ${user.get<number>('n') ?? 0}`,
      `chatSession (everyone here): ${chat.get<number>('n') ?? 0}`,
    ],
    keyboard: [[nav.button('➕ Count', count)]],
  };
});

const count = page('count').render(async ({ ctx, app, session, nav }) => {
  const [user, chat] = await Promise.all([app.userSession(ctx), app.chatSession(ctx)]);
  for (const s of [session, user, chat]) s.set('n', (s.get<number>('n') ?? 0) + 1);
  return nav.redirect(counters);
});

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG().register(counters, count);
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, counters));
bot.start();
```

Outside updates (a Mini App's server, a webhook), `app.withUser(bot, userId, fn)`
gives you a user's `session` and `userSession`, saved like an update; see
[Mini Apps](mini-apps.md#acting-for-the-user).

[`examples/sessions.ts`](../examples/sessions.ts) shows the three side by side.

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

- `session.ttlMs` applies to all three kinds.
- **Per-key TTL** works with any storage adapter, because the expiry is stored
  inside the session.
- **Session TTL** is passed to your adapter's `set`. By default any
  interaction keeps the session alive (`refreshOnActivity: true`); to save
  writes, the expiry is refreshed once half of the TTL has passed. With
  `refreshOnActivity: false`, only changes extend it.
- Without `session.ttlMs`, sessions never expire.

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

`fromVersion` is 0 for data stored before you set a version. Each session, user
session and chat session is migrated once, the next time it is loaded; new sessions start
at the current version.

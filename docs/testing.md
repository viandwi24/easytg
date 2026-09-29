# Testing your bot

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

// telegramError(description, { code?, retryAfter? }): retryAfter in seconds, like Telegram's retry_after
t.responders.editMessageText = () => telegramError('Bad Request: message to edit not found');
t.responders.sendMessage = () => telegramError('Forbidden: bot was blocked by the user', { code: 403 });

createTestBot({ botInfo: { id: 2, username: 'second_bot' } }); // several bots, e.g. sharing one storage
```

`createTestBot` records API calls and lets you check them. For tests that
read like a conversation (what does the chat show after pressing this?), use
the [simulator](simulator.md): it keeps the messages, edits them in place and
answers like Telegram, errors included.

The fake API answers `send*`, `copyMessage(s)` and `forwardMessage(s)` like
Telegram: albums return one message per item, and copies return
`{ message_id }`.

## Scheduled tasks

`app.runDueTasks(bot)` runs the tasks that are due now. To test later ones,
move the clock with Bun's `setSystemTime`:

```ts
import { setSystemTime } from 'bun:test';

await app.schedule(remind, { chatId: 7 }, { delayMs: 3600_000 });
expect(await app.runDueTasks(t.bot)).toBe(0);            // not due yet
setSystemTime(new Date(Date.now() + 3601_000));
expect(await app.runDueTasks(t.bot)).toBe(1);
setSystemTime();                                          // back to the real clock
```

## Several processes

Two app instances with one shared `MemoryStorage` and `cluster: true` behave
like two processes of the same bot, which is handy to test rate limits, locks
and queues across processes:

```ts
const storage = new MemoryStorage();
const a = createTestBot(); a.bot.use(new EasyTG({ storage, cluster: true }));
const b = createTestBot(); b.bot.use(new EasyTG({ storage, cluster: true }));
```

## Storage adapters

`verifyStorageAdapter(adapter, { ttlMs })` and `verifyTaskStore(store)` check
your own [storage](storage.md) implementations.

`MemoryStorage` (the default) stores JSON like SQLite and Redis do, so a test
fails when you put something in a session that wouldn't survive a real store
(a `Date` comes back as a string, a `Map` as `{}`, `undefined` is rejected).

## Examples

[`examples/testing.test.ts`](../examples/testing.test.ts) shows a complete setup:
- helpers to read the screen and press buttons by label,
- dialogues with contact sharing,
- page text input and scheduled tasks,
- simulated Telegram errors,
- broadcasts.

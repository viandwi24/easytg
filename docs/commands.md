# Commands

`app.command` binds a `/command` to a page or a dialogue, and
`app.syncCommands` puts the commands in Telegram's command menu (the ☰ button
next to the message field), so the menu always matches your code.

```ts
const app = new EasyTG()
  .command('start', home, { description: 'Main menu' })
  .command(['find', 'search'], search, { description: 'Search the catalog', params: (args) => ({ q: args }) })
  .command('feedback', feedbackForm, { description: 'Send us feedback' })
  .command('settings', settings, { description: 'Settings', chats: 'private' })
  .command('debug', debugPage); // no description: works, but isn't listed

bot.use(app);
await app.syncCommands(bot); // at startup
```

- The target is registered if it isn't yet. A page opens like `app.open`
  (a reply to the command), a dialogue starts in a new message.
- `params` turns the text after the command into params: `/find green tea`
  gives `args === 'green tea'`. Without `params` the target gets none, so it
  can't require params.
- `/command@yourbot` works too; `/command@otherbot` is left alone.
- A command leaves an active dialogue (with `dialogues.cancelOnCommand`, the
  default) and a page's [text input](text-input.md).
- Commands easytg doesn't know go on to your own handlers
  (`bot.command(...)` after `bot.use(app)`). A `/start <payload>`
  [deep link](deep-links.md) is handled first; other `/start` payloads reach
  your `start` command.
- Names are 1–32 lowercase letters, digits or underscores; defining one twice
  throws.

## Private chats and groups

`chats: 'private'` or `chats: 'groups'` limits where a command works;
elsewhere it goes on to your handlers. `syncCommands` sets one list for all
chats and, when some commands are only for private chats or only for groups,
separate lists for those (Telegram shows the most specific list). Lists for a
kind of chat without commands of its own are deleted.

## Translated descriptions

A description can be a function of the language. `syncCommands` then sets one
list per language of `i18n.messages` / `i18n.locales` (Telegram uses two-letter
codes, so `pt-br` counts as `pt`), plus the default list in `fallbackLocale`:

```ts
app.command('help', help, { description: (locale, t) => t('commands.help') });
```

## Try it

A whole bot. On the [docs site](https://viandwi24.github.io/easytg/) it runs next to the code, in a Telegram simulator: press ☰ Menu next to the message field.

```ts playground
import { Bot } from 'grammy';
import { EasyTG, dialogue, md, page } from 'easytg';

const teas = ['Green tea', 'Black tea', 'Mint tea', 'Jasmine tea'];

const home = page('home').render(() => ({ text: 'Hi! Try /find mint, /feedback or the ☰ Menu button.' }));

const find = page<{ q?: string }>('find').render(({ params }) => {
  const found = teas.filter((t) => t.toLowerCase().includes((params.q ?? '').toLowerCase()));
  return { text: [md`Results for **${params.q || 'everything'}**:`, ...found.map((t) => md`- ${t}`)] };
});

const feedback = dialogue('feedback')
  .steps([{ id: 'text', type: 'text', text: 'What would you like to tell us?' }])
  .onFinish(({ answers }) => ({ text: md`Thanks! We got: “${answers.text}”` }));

const bot = new Bot(process.env.BOT_TOKEN!);
const app = new EasyTG()
  .command('start', home, { description: 'Main menu' })
  .command('find', find, { description: 'Search teas', params: (q) => ({ q }) })
  .command('feedback', feedback, { description: 'Send feedback' });
bot.use(app);
await app.syncCommands(bot);
bot.start();
```

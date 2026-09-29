# Main menu (reply keyboard)

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

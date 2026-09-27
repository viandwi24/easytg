import type { Context } from 'grammy';
import type { KeyboardButton, ReplyKeyboardMarkup } from 'grammy/types';
import type { Dialogue, Page } from './define';

/** A label, or a label per language. */
export type MenuLabel = string | ((locale: string | undefined) => string);

export type MenuButton<C extends Context = Context> =
  | {
      text: MenuLabel;
      /** Page to open or dialogue to start. It can't require params: reply buttons only send their label. */
      target: Page<any, C, any> | Dialogue<any, any, C>;
    }
  | {
      /** Default: `texts.closeMenu`. */
      text?: MenuLabel;
      /** Removes the menu from the keyboard. */
      action: 'close';
    };

/** What pressing a menu button does. */
export type MenuTarget<C extends Context> = Page<any, C, any> | Dialogue<any, any, C> | 'close';

export interface ReplyMenuOptions {
  /** Placeholder shown in the input field while the menu is open. */
  placeholder?: string;
  /** Keep the menu open instead of collapsing it after use. Default true. */
  persistent?: boolean;
}

/**
 * A main menu on the reply keyboard (the buttons below the input field).
 * Pressing a button sends its label as a message; easytg opens its page as a
 * new message, or starts its dialogue.
 *
 *   const mainMenu = replyMenu([
 *     [replyMenu.button('🛍 Products', productList), replyMenu.button('🧾 Orders', myOrders)],
 *   ]);
 *   new EasyTG({ menu: mainMenu });
 *   bot.command('start', (ctx) => app.showMenu(ctx, 'Welcome!'));
 */
export class ReplyMenu<C extends Context = Context> {
  /** @internal */ readonly rows: MenuButton<C>[][];
  /** @internal */ readonly options: ReplyMenuOptions;

  /** @internal Use `replyMenu(rows)`. */
  constructor(rows: MenuButton<C>[][], options: ReplyMenuOptions = {}) {
    this.rows = rows;
    this.options = options;
  }

  /** @internal */
  markup(locale: string | undefined, closeLabel: string): ReplyKeyboardMarkup {
    return {
      keyboard: this.rows.map((row) =>
        row.map((button): KeyboardButton => ({ text: button.text === undefined ? closeLabel : label(button.text, locale) })),
      ),
      resize_keyboard: true,
      is_persistent: this.options.persistent ?? true,
      input_field_placeholder: this.options.placeholder,
    };
  }

  /** @internal The target of the button whose label is `text`, in the user's language. */
  match(text: string, locale: string | undefined, closeLabel: string): MenuTarget<C> | undefined {
    for (const row of this.rows) {
      for (const button of row) {
        const shown = button.text === undefined ? closeLabel : label(button.text, locale);
        if (shown === text) return 'action' in button ? 'close' : button.target;
      }
    }
    return undefined;
  }
}

function label(text: MenuLabel, locale: string | undefined) {
  return typeof text === 'function' ? text(locale) : text;
}

/** Create a reply-keyboard main menu. See `ReplyMenu`. */
export function replyMenu<C extends Context = Context>(rows: MenuButton<C>[][], options?: ReplyMenuOptions): ReplyMenu<C> {
  return new ReplyMenu(rows, options);
}

/** A menu button. The target can't require params. */
replyMenu.button = <P, C extends Context = Context>(
  text: MenuLabel,
  target: {} extends P ? Page<P, C, any> | Dialogue<any, P, C> : never,
): MenuButton<C> => ({ text, target: target as Page<any, C, any> | Dialogue<any, any, C> });

/**
 * A button that removes the menu from the keyboard. Telegram removes reply
 * keyboards with a message, so pressing it sends `texts.menuClosed`.
 */
replyMenu.close = <C extends Context = Context>(text?: MenuLabel): MenuButton<C> => ({ text, action: 'close' });

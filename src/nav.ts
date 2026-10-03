import type { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { BACK_ID, EXIT_ID, normalizeParams, type ParamsInput } from './callback';
import type { EasyTG } from './engine';
import { EasyTGError } from './errors';
import type { Dialogue, Page } from './define';
import { DialogueStart, Redirect, type ButtonOptions, type ParamArgs, type Params, type ParamsArgs } from './types';

type Target<P> = Page<P, any, any> | Dialogue<any, P, any>;

/**
 * Builds buttons and navigation results for the current update. You get one
 * in every render (`args.nav`) and dialogue callback; use `app.nav(ctx)`
 * elsewhere.
 */
export class Nav<C extends Context = Context> {
  /** @internal */
  constructor(
    private readonly app: EasyTG<C>,
    private readonly ctx: C,
    private readonly current?: { id: string; params: Record<string, string> },
  ) {}

  /** Button that opens a page or starts a dialogue. */
  button<P = Params>(text: string, target: Target<P>, ...args: ParamsArgs<P>): InlineKeyboardButton;
  button(text: string, target: string, params?: ParamsInput, options?: ButtonOptions): InlineKeyboardButton;
  button(text: string, target: Target<any> | string, params?: ParamsInput, options?: ButtonOptions): InlineKeyboardButton {
    const id = typeof target === 'string' ? target : target.id;
    this.app.noteFlow(this.ctx, id, 'button', text);
    return { text, callback_data: this.app.callbackData(this.ctx, id, params, options) };
  }

  /** Raw callback data for a page or dialogue (for hand-built keyboards). */
  data<P = Params>(target: Target<P>, ...args: ParamsArgs<P>): string;
  data(target: string, params?: ParamsInput, options?: ButtonOptions): string;
  data(target: Target<any> | string, params?: ParamsInput, options?: ButtonOptions): string {
    const id = typeof target === 'string' ? target : target.id;
    this.app.noteFlow(this.ctx, id, 'button');
    return this.app.callbackData(this.ctx, id, params, options);
  }

  /** Button that re-opens the current page with some params changed. */
  self(text: string, params: ParamsInput = {}, options?: ButtonOptions): InlineKeyboardButton {
    if (!this.current) throw new EasyTGError('nav.self() is only available while rendering a page');
    return this.button(text, this.current.id, { ...this.current.params, ...params }, options);
  }

  home(text = this.app.textsFor(this.ctx).home): InlineKeyboardButton {
    return this.button(text, this.app.homePage);
  }

  /**
   * Button back to the page this menu showed before (with its params), or
   * `false` when there is none, e.g. in a freshly sent message. Falsy entries
   * are dropped from keyboards, so it can be used as is:
   * `keyboard: [[nav.back(), nav.home()]]`.
   */
  back(text = this.app.textsFor(this.ctx).back): InlineKeyboardButton | false {
    return this.app.canGoBack(this.ctx) ? { text, callback_data: `p|${BACK_ID}` } : false;
  }

  /**
   * A button that is shown but does nothing (greyed out by Telegram): a label
   * in a grid, an option that isn't available right now.
   */
  disabled(text: string): InlineKeyboardButton {
    return { text, disabled: {} };
  }

  /** Button that deletes the message. */
  close(text = this.app.textsFor(this.ctx).close): InlineKeyboardButton {
    return { text, callback_data: `p|${EXIT_ID}` };
  }

  /**
   * `https://t.me/<bot>?start=...` link that opens a page or starts a dialogue
   * (it must call `.allowDeepLink()`). Links are not bound to a user: share them freely.
   */
  deepLink<P = Params>(target: Target<P>, ...args: ParamsArgs<P>): string;
  deepLink(target: Target<any>, params?: ParamsInput, options?: ButtonOptions): string {
    return this.app.deepLinkFor(this.ctx, target.id, params, options);
  }

  /**
   * Link button. Telegram only accepts `http://`, `https://` and `tg://` URLs
   * (no `mailto:` or `tel:`): others throw here instead of failing at send time.
   */
  url(text: string, url: string): InlineKeyboardButton {
    if (!/^(https?|tg):\/\//i.test(url)) {
      throw new EasyTGError(`nav.url("${text}"): Telegram only allows http(s):// and tg:// links, got "${url}"`);
    }
    return { text, url };
  }

  /**
   * The Pay button of an invoice (`invoice` content). It must be the first
   * button; without a keyboard, Telegram shows its own Pay button.
   */
  pay(text: string): InlineKeyboardButton {
    return { text, pay: true };
  }

  /** Mini App button; Telegram requires an https:// URL. */
  webApp(text: string, url: string): InlineKeyboardButton {
    if (!/^https:\/\//i.test(url)) throw new EasyTGError(`nav.webApp("${text}"): Mini Apps need an https:// URL, got "${url}"`);
    return { text, web_app: { url } };
  }

  /** Return this from a render or middleware to show another page instead. */
  redirect<P = Params>(target: Page<P, any, any>, ...args: ParamArgs<P>): Redirect;
  redirect(target: string, params?: ParamsInput): Redirect;
  redirect(target: Page<any, any, any> | string, params?: ParamsInput): Redirect {
    const id = typeof target === 'string' ? target : target.id;
    this.app.noteFlow(this.ctx, id, 'redirect');
    return new Redirect(id, normalizeParams(params));
  }

  /** Return this from a render to start a dialogue (the current menu is closed). */
  startDialogue<P = Params>(dialogue: Dialogue<any, P, any>, ...args: ParamArgs<P>): DialogueStart;
  startDialogue(dialogue: Dialogue<any, any, any>, params?: ParamsInput): DialogueStart {
    // Strings, like when the dialogue is started from a button.
    this.app.noteFlow(this.ctx, dialogue.id, 'dialogue');
    return new DialogueStart(dialogue.id, normalizeParams(params));
  }

  /** @internal Raw (string) params of the page being rendered, before `.params(parse)`. */
  get currentParams(): Record<string, string> | undefined {
    return this.current?.params;
  }
}

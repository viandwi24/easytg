import type { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { EXIT_ID, normalizeParams, type ParamsInput } from './callback';
import type { EasyTG } from './engine';
import type { Dialogue, Page } from './define';
import { DialogueStart, Redirect, type ButtonOptions, type Params, type ParamsArgs } from './types';

type Target<P> = Page<P, any> | Dialogue<any, P, any>;

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
    return { text, callback_data: this.data(target as string, params, options) };
  }

  /** Raw callback data for a page or dialogue (for hand-built keyboards). */
  data<P = Params>(target: Target<P>, ...args: ParamsArgs<P>): string;
  data(target: string, params?: ParamsInput, options?: ButtonOptions): string;
  data(target: Target<any> | string, params?: ParamsInput, options?: ButtonOptions): string {
    const id = typeof target === 'string' ? target : target.id;
    return this.app.callbackData(this.ctx, id, params, options);
  }

  /** Button that re-opens the current page with some params changed. */
  self(text: string, params: ParamsInput = {}, options?: ButtonOptions): InlineKeyboardButton {
    if (!this.current) throw new Error('nav.self() is only available while rendering a page');
    return this.button(text, this.current.id, { ...this.current.params, ...params }, options);
  }

  home(text = this.app.textsFor(this.ctx).home): InlineKeyboardButton {
    return this.button(text, this.app.homePage);
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

  url(text: string, url: string): InlineKeyboardButton {
    return { text, url };
  }

  webApp(text: string, url: string): InlineKeyboardButton {
    return { text, web_app: { url } };
  }

  /** Return this from a render or middleware to show another page instead. */
  redirect<P = Params>(target: Page<P, any>, ...args: ParamsArgs<P>): Redirect;
  redirect(target: string, params?: ParamsInput): Redirect;
  redirect(target: Page<any, any> | string, params?: ParamsInput): Redirect {
    return new Redirect(typeof target === 'string' ? target : target.id, normalizeParams(params));
  }

  /** Return this from a render to start a dialogue (the current menu is closed). */
  startDialogue<P = Params>(dialogue: Dialogue<any, P, any>, ...args: ParamsArgs<P>): DialogueStart;
  startDialogue(dialogue: Dialogue<any, any, any>, params: Record<string, unknown> = {}): DialogueStart {
    return new DialogueStart(dialogue.id, params);
  }
}

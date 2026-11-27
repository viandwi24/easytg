// What easytg does with each kind of update: button presses, menu buttons,
// dialogue answers, deep links, /commands, relays, payments and `page.onText`.
// Each handler returns false for updates that aren't its own.
import type { Context } from 'grammy';
import type { PreCheckoutQuery, SuccessfulPayment } from 'grammy/types';
import { BACK_ID, DIALOGUE_BUTTON_ID, EXIT_ID, LEGACY_EXIT_ID, decodeInline, decodeStoredToken, normalizeParams } from '../callback';
import { decodeDeepLink, startPayload } from '../deeplink';
import { isCommand, parseWebAppData } from '../dialogue';
import type { EasyTG } from '../engine';
import { InvalidParamsError, isChatUnreachable, isMessageUnavailable, isNotModified } from '../errors';
import { INPUT_KEY, type TextInputState } from './scope';
import type { ErrorsOptions, PaymentArgs, PaymentsOptions, RelayOptions } from './types';

/** @internal */
export class Handlers<C extends Context> {
  private readonly doubleTapMs: number;

  constructor(
    private readonly app: EasyTG<C>,
    private readonly payments: PaymentsOptions<C> | undefined,
    private readonly relayFilter: RelayOptions<C>['filter'] | undefined,
    doubleTapMs: number | undefined,
    private readonly errors: ErrorsOptions<C> = {},
  ) {
    this.doubleTapMs = doubleTapMs ?? 700;
  }

  /** Route an update to its handler; `next` passes it on to the app's own handlers. */
  async handle(ctx: C, next: () => Promise<void>) {
    // The user pressed stop under a streamed draft (app.stream).
    const stopped = ctx.update.stopped_message_generation;
    if (stopped) this.app.loading.stop(stopped.chat.id, stopped.draft_id);
    if (this.payments && ctx.preCheckoutQuery) {
      await this.preCheckout(ctx, ctx.preCheckoutQuery);
      return;
    }
    if (this.payments && ctx.message?.successful_payment) {
      if (!(await this.payment(ctx, ctx.message.successful_payment))) await next();
      return;
    }
    if (ctx.callbackQuery?.data) {
      if (await this.callback(ctx)) return;
    } else if (ctx.editedMessage) {
      if (await this.relayEdit(ctx)) return;
    } else if (ctx.message) {
      if (await this.menu(ctx)) return;
      if (await this.message(ctx)) return;
      if (await this.deepLink(ctx)) return;
      if (await this.command(ctx)) return;
      if (await this.relay(ctx)) return;
      if (await this.textInput(ctx)) return;
      const webAppData = ctx.message.web_app_data;
      if (webAppData) {
        // From a replyMenu.webApp button (a dialogue's webApp step took its own already).
        await this.app.emit('webAppData', { ctx, data: parseWebAppData(webAppData.data), raw: webAppData.data, button: webAppData.button_text });
      }
    }
    await next();
  }

  /** Handle an easytg button press. Returns false for callback data that isn't easytg's. */
  private async callback(ctx: C): Promise<boolean> {
    const app = this.app;
    const data = ctx.callbackQuery?.data;
    if (!data) return false;
    const token = decodeStoredToken(data);
    const inline = token ? null : decodeInline(data);
    if (!token && !inline) return false;

    // Double taps: an identical press right after the previous one finished is
    // dropped. (One press at a time is enforced by the update lock.)
    const pressKey = `press:${ctx.me.id}:${ctx.chat?.id}:${ctx.from?.id}`;
    const signature = `${ctx.callbackQuery?.message?.message_id ?? ctx.callbackQuery?.inline_message_id}|${data}`;
    if (this.doubleTapMs > 0 && (await app.coordination.get(pressKey)) === signature) {
      app.logger.debug('Ignored double tap');
      await app.delivery.answerCallback(ctx);
      return true;
    }

    const answer = (text: string) => app.delivery.answerCallback(ctx, { text, show_alert: true });
    try {
      await app.sessions.state(ctx); // resolves the user's language
      const texts = app.textsFor(ctx);
      let id: string;
      let params: Record<string, string>;
      if (token) {
        const resolved = await app.buttons.callbacks.resolve(token, ctx.from?.id, app.scopes.botScope(ctx));
        if (resolved.status !== 'ok') {
          await answer(resolved.status === 'forbidden' ? texts.notYourMenu : texts.buttonExpired);
          return true;
        }
        ({ id, params } = resolved);
      } else {
        ({ id, params } = inline!);
        // In `stored` mode, inline params can only come from a forged request;
        // in `signed` mode they need a valid signature.
        if (id !== DIALOGUE_BUTTON_ID && Object.keys(params).length > 0 && !app.buttons.acceptInline(ctx, id, params)) {
          app.logger.debug(`Rejected inline params for "${id}" (${app.buttons.mode} mode)`);
          await answer(texts.buttonExpired);
          return true;
        }
      }
      // Per-button delivery mode.
      const modeKey = app.buttons.modeKey;
      const sendNew = params[modeKey] === 's';
      const ephemeral = params[modeKey] === 'e';
      delete params[modeKey];

      if (!(await app.buttons.isMenuOwner(ctx))) {
        await answer(texts.notYourMenu);
        return true;
      }

      const page = app.pages.get(id);
      const dialogue = app.dialogueDefs.get(id);
      if (id === DIALOGUE_BUTTON_ID) {
        if (!(await app.dialogues.handleButton(ctx, params))) await answer(texts.buttonExpired);
      } else if (id === BACK_ID) {
        await app.views.goBack(ctx);
      } else if (id === EXIT_ID || (id === LEGACY_EXIT_ID && !page && !dialogue)) {
        await app.delivery.closeMessage(ctx);
        // The closed message can't take text anymore.
        const session = await app.sessions.state(ctx);
        if (session.get<TextInputState>(INPUT_KEY)?.messageId === ctx.callbackQuery?.message?.message_id) session.delete(INPUT_KEY);
      } else if (page) {
        await app.open(ctx, page.id, params, { mode: ephemeral ? 'ephemeral' : sendNew ? 'send' : 'edit' });
      } else if (dialogue) {
        // An ephemeral start leaves the shared menu alone: it stays for the others.
        await app.views.guardedDialogueStart(ctx, dialogue, params, { mode: ephemeral ? 'ephemeral' : sendNew ? 'send' : 'edit', closeMenu: !sendNew && !ephemeral });
      } else {
        await answer(texts.pageNotFound);
      }
    } catch (error) {
      if (error instanceof InvalidParamsError) {
        app.logger.debug('Rejected params', error);
        await answer(app.textsFor(ctx).pageNotFound);
      } else {
        if (this.notifies(ctx, error, 'button')) await answer(app.textsFor(ctx).error);
        await this.reportError(error, ctx); // throws with `errors.rethrow`
      }
    } finally {
      await app.delivery.answerCallback(ctx); // no-op if already answered
      if (this.doubleTapMs > 0) await app.coordination.set(pressKey, signature, this.doubleTapMs);
    }
    return true;
  }

  /** A main-menu button: open its page / start its dialogue. False if the text isn't a menu label. */
  private async menu(ctx: C): Promise<boolean> {
    const app = this.app;
    const text = ctx.message?.text;
    if (!app.menu || text === undefined) return false;
    try {
      await app.sessions.state(ctx); // resolves the user's language
      const texts = app.textsFor(ctx);
      const target = app.menu.match(text, app.localeOf(ctx), texts.closeMenu, app.t(ctx));
      if (!target) return false;
      // Like a /command, a menu button leaves the current dialogue.
      if (app.cancelDialogueOnCommand) await app.dialogues.cancel(ctx, { render: false });
      if (target === 'close') {
        (await app.sessions.state(ctx)).delete(INPUT_KEY);
        await app.delivery.deliverContent(ctx, { text: texts.menuClosed, parseMode: 'plain' }, 'send', { remove_keyboard: true });
      }
      else if (target.kind === 'page') await app.open(ctx, app.page(target), {}, { mode: 'send' });
      else await app.views.guardedDialogueStart(ctx, app.dialogue(target), {}, { mode: 'send', closeMenu: false });
      return true;
    } catch (error) {
      await this.failed(error, ctx);
      return true;
    }
  }

  /** Feed a message to the active dialogue. Returns false if there is none. */
  private async message(ctx: C): Promise<boolean> {
    try {
      return await this.app.dialogues.handleMessage(ctx);
    } catch (error) {
      await this.failed(error, ctx);
      return true;
    }
  }

  /** Open the page / start the dialogue of a `/start <payload>` deep link. False if it isn't one of ours. */
  private async deepLink(ctx: C): Promise<boolean> {
    const app = this.app;
    const payload = startPayload(ctx.message?.text, ctx.me?.username);
    const decoded = payload ? decodeDeepLink(payload) : null;
    if (!decoded) return false;

    try {
      let id: string;
      let params: Record<string, string>;
      if (decoded.kind === 'stored') {
        const resolved = await app.buttons.deepLinks.resolve(decoded.token, undefined);
        if (resolved.status !== 'ok') return false;
        ({ id, params } = resolved);
      } else {
        ({ id, params } = decoded);
        if (Object.keys(params).length > 0 && !app.buttons.acceptInline(ctx, id, params, true)) return false;
      }

      const page = app.pages.get(id);
      const dialogue = app.dialogueDefs.get(id);
      if (page?.deepLinkEnabled) await app.open(ctx, page.id, params, { mode: 'send' });
      else if (dialogue?.deepLinkEnabled) await app.views.guardedDialogueStart(ctx, dialogue, params, { mode: 'send', closeMenu: false });
      else return false; // unknown or not linkable: let the app's own /start run
      return true;
    } catch (error) {
      await this.failed(error, ctx);
      return true;
    }
  }

  /** A command from `app.command`. False if the message isn't one. */
  private async command(ctx: C): Promise<boolean> {
    const app = this.app;
    if (!app.commands.size) return false;
    const found = app.commands.match(ctx.message, ctx.me?.username);
    if (!found) return false;
    try {
      (await app.sessions.state(ctx)).delete(INPUT_KEY); // a command moves on from the page's text input
      const { target, options } = found.entry;
      const params = normalizeParams(options.params?.(found.args));
      if (target.kind === 'page') await app.open(ctx, app.page(target), params);
      else await app.views.guardedDialogueStart(ctx, app.dialogue(target), params, { mode: 'send', closeMenu: false });
    } catch (error) {
      await this.failed(error, ctx);
    }
    return true;
  }

  /** A message in a relay: copy it to the other user. False if the user isn't in one. */
  private async relay(ctx: C): Promise<boolean> {
    const app = this.app;
    const message = ctx.message;
    const from = ctx.from;
    if (!message || !from || message.chat.type !== 'private' || isCommand(message, ctx.me?.username)) return false;
    // Service messages (Mini App data, payments, pins…) can't be copied: they go on to their handlers.
    if (message.web_app_data || message.successful_payment || message.pinned_message || message.refunded_payment) return false;
    const botId = ctx.me.id;
    const link = await app.relays.get(botId, from.id);
    if (!link) return false;
    try {
      const verdict = this.relayFilter ? await this.relayFilter({ ctx, peer: link.peer }) : undefined;
      if (verdict === false) return true;
      if (typeof verdict === 'string') {
        await ctx.reply(verdict);
        return true;
      }
      // A reply to a relayed message replies to its counterpart on the other side.
      const repliedTo = message.reply_to_message && (await app.relays.counterpart(botId, { chat: message.chat.id, id: message.reply_to_message.message_id }));
      const copy = await ctx.api.copyMessage(link.peer, message.chat.id, message.message_id, {
        ...(repliedTo?.chat === link.peer ? { reply_parameters: { message_id: repliedTo.id, allow_sending_without_reply: true } } : {}),
      });
      await app.relays.pair(botId, { chat: message.chat.id, id: message.message_id }, { chat: link.peer, id: copy.message_id });
      await app.emit('relayMessage', { ctx, from: from.id, to: link.peer, messageId: message.message_id });
    } catch (error) {
      if (isChatUnreachable(error)) {
        await app.relays.end(botId, from.id);
        await app.emit('relayEnd', { botId, users: [from.id, link.peer], reason: 'unreachable', ctx });
        return true;
      }
      await this.failed(error, ctx);
    }
    return true;
  }

  /** An edited message that was relayed: edit its copy too. False if it wasn't relayed. */
  private async relayEdit(ctx: C): Promise<boolean> {
    const edited = ctx.editedMessage;
    if (!edited || edited.chat.type !== 'private' || !ctx.from) return false;
    const copy = await this.app.relays.counterpart(ctx.me.id, { chat: edited.chat.id, id: edited.message_id });
    if (!copy) return false;
    try {
      if (edited.text !== undefined) await ctx.api.editMessageText(copy.chat, copy.id, edited.text, { entities: edited.entities });
      else if (edited.caption !== undefined) await ctx.api.editMessageCaption(copy.chat, copy.id, { caption: edited.caption, caption_entities: edited.caption_entities });
    } catch (error) {
      // Gone, too old to edit, or unchanged: nothing to do.
      if (!isMessageUnavailable(error) && !isNotModified(error)) await this.reportError(error, ctx);
    }
    return true;
  }

  private async preCheckout(ctx: C, query: PreCheckoutQuery) {
    let answer: true | string;
    try {
      answer = this.payments!.preCheckout ? await this.payments!.preCheckout({ ctx, query, payload: query.invoice_payload }) : true;
    } catch (error) {
      // Not rethrown: the checkout must be answered within Telegram's 10 seconds.
      if ((await this.app.emit('error', { error, ctx, source: 'update' })) === 0) this.app.logger.error('Error in payments.preCheckout', error);
      answer = this.app.textsFor(ctx).error;
    }
    await ctx.answerPreCheckoutQuery(answer === true, answer === true ? undefined : { error_message: answer });
  }

  /** Emit `payment` and show `onSuccess`'s result. False if there is no `onSuccess`. */
  private async payment(ctx: C, payment: SuccessfulPayment): Promise<boolean> {
    const app = this.app;
    const payload = payment.invoice_payload;
    await app.emit('payment', { ctx, payment, payload });
    const onSuccess = this.payments!.onSuccess;
    if (!onSuccess) return false;
    try {
      const session = await app.session(ctx);
      const args: PaymentArgs<C> = { ctx, payment, payload, session, locale: app.localeOf(ctx), t: app.t(ctx), nav: app.nav(ctx), app };
      await app.views.showResult(ctx, await onSuccess(args), 'send');
    } catch (error) {
      await this.failed(error, ctx);
    }
    return true;
  }

  /** Text for the last page shown, if it has `onText`. False if there is none. */
  private async textInput(ctx: C): Promise<boolean> {
    const app = this.app;
    const message = ctx.message;
    if (message?.text === undefined) return false;
    const session = await app.sessions.state(ctx);
    if (isCommand(message)) {
      session.delete(INPUT_KEY); // a command moves on: later text isn't for the page anymore
      return false;
    }
    const input = session.get<TextInputState>(INPUT_KEY);
    if (!input || typeof input !== 'object') return false;
    const page = app.pages.get(input.id);
    if (!page?.textFn) {
      session.delete(INPUT_KEY);
      return false;
    }
    // In groups, only replies to the page's message are meant for it.
    if (message.chat.type !== 'private' && message.reply_to_message?.message_id !== input.messageId) return false;

    const { mode = 'send', deleteInput = false } = page.textOptions;
    const scope = () => app.scopes.get(ctx);
    scope().flowFrom = page.id;
    try {
      if (mode === 'edit') scope().editTarget = { chatId: message.chat.id, messageId: input.messageId };
      await app.views.show(ctx, page.id, mode, () =>
        app.views.guard(ctx, page, input.params, async ({ target: _target, ...args }) => {
          scope().view = { id: page.id, params: input.params };
          return page.textFn!({ ...args, params: await app.views.parseParams(page, input.params), page, text: message.text! });
        }),
      );
      if (deleteInput) {
        await ctx.deleteMessage().catch((error: unknown) => app.logger.debug('Failed to delete the input message', error));
      }
    } catch (error) {
      if (error instanceof InvalidParamsError) {
        session.delete(INPUT_KEY);
        return false;
      }
      await this.failed(error, ctx);
    } finally {
      scope().editTarget = undefined;
    }
    return true;
  }

  /** An error of a message handler: tell the user something went wrong (see `errors.notify`), then report it. */
  private async failed(error: unknown, ctx: C) {
    if (this.notifies(ctx, error, 'message')) {
      try {
        await ctx.reply(this.app.textsFor(ctx).error);
      } catch {}
    }
    await this.reportError(error, ctx);
  }

  private notifies(ctx: C, error: unknown, on: 'button' | 'message'): boolean {
    const notify = this.errors.notify ?? true;
    if (typeof notify === 'boolean') return notify;
    try {
      return notify({ ctx, error, on });
    } catch (failure) {
      this.app.logger.error('errors.notify failed', failure);
      return true;
    }
  }

  /** Emit `error` (or log it), or throw it on to grammY with `errors.rethrow`. */
  private async reportError(error: unknown, ctx: C) {
    if (this.errors.rethrow) throw error;
    if ((await this.app.emit('error', { error, ctx, source: 'update' })) === 0) this.app.logger.error('Error while handling update', error);
  }
}

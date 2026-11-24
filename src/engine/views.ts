// Showing pages: middlewares and render, redirects and dialogue starts, and
// the per-message Back history that `nav.back()` and `page.onText` rely on.
import type { Context } from 'grammy';
import type { Dialogue, Page } from '../define';
import type { EasyTG } from '../engine';
import { EasyTGError, InvalidParamsError } from '../errors';
import { Nav } from '../nav';
import type { DeliveryResult, EditTarget } from '../render';
import { DialogueStart, Redirect, type DeliveryMode, type LoadingOptions, type MiddlewareArgs, type Params, type RenderArgs, type RenderResult } from '../types';
import {
  INPUT_KEY,
  MAX_BACK_STEPS,
  MAX_NAV_MESSAGES,
  MAX_REDIRECTS,
  NAV_KEY,
  keyOf,
  pressedKey,
  type MessageKey,
  type NavHistory,
  type TextInputState,
} from './scope';

/** @internal */
export class Views<C extends Context> {
  constructor(
    private readonly app: EasyTG<C>,
    /** Loading indicators for pages without their own. */
    private readonly defaultLoading: LoadingOptions | undefined,
  ) {}

  /** Render (`render` belongs to page `pageId`), deliver, and record the view. */
  async show(ctx: C, pageId: string, mode: DeliveryMode, render: () => Promise<RenderResult>, depth = 0) {
    const app = this.app;
    const scope = app.scopes.get(ctx);
    const sourceId: MessageKey | undefined = pressedKey(ctx) ?? scope.editTarget?.messageId;
    // An ephemeral open from a menu continues that menu's history, on the presser's own copy.
    const editing = sourceId !== undefined && (mode === 'edit' || mode === 'auto' || mode === 'ephemeral');

    // Navigating within a menu message pushes the page it showed onto its back stack.
    if (!scope.navStack) {
      const entry = editing ? (await this.navHistory(ctx))[sourceId] : undefined;
      scope.navStack = !entry
        ? []
        : entry.current.id === pageId
          ? entry.stack // same page with other params (pagination, filters): not a new step
          : [...entry.stack, entry.current].slice(-MAX_BACK_STEPS);
    }

    const started = Date.now();
    let previousTarget: { value: EditTarget | undefined } | undefined;
    try {
      const own = app.pages.get(pageId)?.loadingOptions;
      const loading = own === undefined ? this.defaultLoading : own;
      const result = loading ? await app.loading.withPlaceholder(ctx, loading, render) : await render();
      // A placeholder message was sent while rendering: the page replaces it.
      let target: MessageKey | undefined = editing ? sourceId : undefined;
      if (scope.placeholder) {
        previousTarget = { value: scope.editTarget };
        scope.editTarget = scope.placeholder;
        scope.placeholder = undefined;
        target = scope.editTarget.messageId;
        mode = 'edit';
      }
      const delivered = await this.present(ctx, result, mode, depth);
      if (delivered && scope.view) {
        await this.recordView(ctx, delivered, target);
        await app.delivery.scheduleRefresh(ctx, delivered, target);
        const inPlace = delivered === true || (target !== undefined && keyOf(delivered) === target);
        await app.emit('pageView', {
          ctx,
          page: scope.view.id,
          params: scope.view.params,
          mode: inPlace ? 'edit' : 'send',
          chatId: ctx.chat?.id ?? scope.editTarget?.chatId,
          userId: ctx.from?.id,
          durationMs: Date.now() - started,
        });
      }
      await app.flush(ctx);
      return delivered;
    } finally {
      scope.navStack = undefined;
      scope.view = undefined;
      scope.refreshEveryMs = undefined;
      // The placeholder was this page's target only: later opens in this update start fresh.
      if (previousTarget) scope.editTarget = previousTarget.value;
    }
  }

  /** A render result that doesn't come from a page render, shown the way pages are. */
  showResult(ctx: C, result: RenderResult, mode: DeliveryMode, depth = 0): Promise<DeliveryResult | undefined> {
    return this.show(ctx, result instanceof Redirect ? result.target : '', mode, async () => result, depth);
  }

  /** Show a render result: content, redirect or dialogue start. */
  async present(ctx: C, result: RenderResult, mode: DeliveryMode, depth = 0): Promise<DeliveryResult | undefined> {
    if (!result) return undefined;
    const app = this.app;

    if (result instanceof Redirect || result instanceof DialogueStart) {
      // Also counted per update: loops through a dialogue that finishes at once and redirects back.
      const scope = app.scopes.get(ctx);
      scope.redirects = (scope.redirects ?? 0) + 1;
      if (scope.redirects > MAX_REDIRECTS * 4) {
        throw new EasyTGError(`Too many redirects in one update (last: "${result instanceof Redirect ? result.target : result.dialogueId}")`);
      }
    }

    if (result instanceof Redirect) {
      if (depth >= MAX_REDIRECTS) throw new EasyTGError(`Too many redirects (last: "${result.target}")`);
      const page = app.page(result.target);
      return this.present(ctx, await this.renderPage(ctx, page, result.params), mode, depth + 1);
    }

    if (result instanceof DialogueStart) {
      const dialogue = app.dialogueDefs.get(result.dialogueId);
      if (!dialogue) throw new EasyTGError(`Dialogue "${result.dialogueId}" is not registered`);
      return this.guardedDialogueStart(ctx, dialogue, result.params, { mode, closeMenu: true }, depth);
    }

    if (result.toast) {
      const toast = typeof result.toast === 'string' ? { text: result.toast } : result.toast;
      await app.delivery.answerCallback(ctx, { text: toast.text, show_alert: toast.alert });
    }
    return (await app.delivery.deliverContent(ctx, result, mode))?.result;
  }

  /** Run the global + target middlewares, then `final`. */
  async guard(
    ctx: C,
    target: Page<any, C, any> | Dialogue<any, any, C>,
    params: Params,
    final: (args: MiddlewareArgs<C>) => Promise<RenderResult>,
  ): Promise<RenderResult> {
    const app = this.app;
    const session = await app.sessions.state(ctx);
    const args: MiddlewareArgs<C> = {
      ctx,
      params,
      session,
      locale: app.localeOf(ctx),
      t: app.t(ctx),
      nav: new Nav(app, ctx, target.kind === 'page' ? { id: target.id, params: params as Record<string, string> } : undefined),
      app,
      target,
    };
    const chain = [...app.middlewares, ...target.middlewares];
    const dispatch = async (i: number): Promise<RenderResult> =>
      i < chain.length ? chain[i]!(args, () => dispatch(i + 1)) : final(args);
    return dispatch(0);
  }

  renderPage(ctx: C, page: Page<any, C, any>, params: Record<string, string>): Promise<RenderResult> {
    const scope = this.app.scopes.get(ctx);
    scope.flowFrom = page.id;
    return this.guard(ctx, page, params, async ({ target: _target, ...args }) => {
      this.app.scopes.get(ctx).view = { id: page.id, params };
      const renderArgs: RenderArgs<any, C> = { ...args, params: await this.parseParams(page, params), page };
      return page.renderFn!(renderArgs);
    });
  }

  /** Validation/conversion by `.params(parse)`; a throw rejects the request. */
  async parseParams(page: Page<any, C, any>, params: Record<string, string>): Promise<unknown> {
    if (!page.parseFn) return params;
    try {
      return await page.parseFn(params);
    } catch (error) {
      throw error instanceof InvalidParamsError ? error : new InvalidParamsError(`Invalid params for "${page.id}": ${error}`);
    }
  }

  /** Start a dialogue unless a middleware stops it; a middleware's result is shown instead. */
  async guardedDialogueStart(
    ctx: C,
    dialogue: Dialogue<any, any, C>,
    params: Record<string, unknown>,
    options: { mode: DeliveryMode; closeMenu: boolean },
    depth = 0,
  ): Promise<DeliveryResult | undefined> {
    if (depth >= MAX_REDIRECTS) throw new EasyTGError(`Too many redirects (last: dialogue "${dialogue.id}")`);
    // Started ephemerally: its prompts go to this user only (where Telegram has ephemeral messages).
    if (options.mode === 'ephemeral') this.app.scopes.get(ctx).ephemeral = true;
    let started = false;
    const result = await this.guard(ctx, dialogue, params as Params, async ({ session }) => {
      await this.app.dialogues.start(ctx, dialogue, params);
      session.delete(INPUT_KEY); // the dialogue takes the user's text now
      started = true;
      return undefined;
    });
    if (!started) return this.showResult(ctx, result, options.mode, depth + 1);
    // The dialogue prompt replaces the menu that started it.
    const fromMenu = ctx.callbackQuery && (options.mode === 'edit' || options.mode === 'auto');
    if (options.closeMenu && fromMenu) await this.app.delivery.closeMessage(ctx);
    return undefined;
  }

  /** Whether the page being rendered has a page to go back to. */
  canGoBack(ctx: C): boolean {
    return (this.app.scopes.peek(ctx)?.navStack?.length ?? 0) > 0;
  }

  /** `nav.back()`: show the previous page of this menu message, or the home page. */
  async goBack(ctx: C) {
    const app = this.app;
    const messageId = pressedKey(ctx);
    const entry = messageId === undefined ? undefined : (await this.navHistory(ctx))[messageId];
    const previous = entry?.stack.at(-1);
    if (previous && app.pages.has(previous.id)) {
      app.scopes.get(ctx).navStack = entry!.stack.slice(0, -1);
      await app.open(ctx, previous.id, previous.params, { mode: 'edit' });
    } else if (app.pages.has(app.homePage)) {
      await app.open(ctx, app.homePage, {}, { mode: 'edit' });
    } else {
      await app.delivery.answerCallback(ctx, { text: app.textsFor(ctx).pageNotFound, show_alert: true });
    }
  }

  private async navHistory(ctx: C): Promise<NavHistory> {
    const history = (await this.app.sessions.state(ctx)).get<NavHistory>(NAV_KEY);
    return history && typeof history === 'object' ? history : {};
  }

  private async recordView(ctx: C, delivered: DeliveryResult, sourceId: MessageKey | undefined) {
    const scope = this.app.scopes.get(ctx);
    const messageId = delivered === true ? sourceId : keyOf(delivered);
    if (messageId === undefined || !scope.view) return;
    const session = await this.app.sessions.state(ctx);
    const history = { ...(await this.navHistory(ctx)) };
    // The menu moved to a new message; unless it opened ephemerally, as the presser's own copy of a shared menu.
    const ephemeralCopy = typeof messageId === 'string' && typeof sourceId === 'number';
    if (sourceId !== undefined && sourceId !== messageId && !ephemeralCopy) delete history[sourceId];
    history[messageId] = { current: scope.view, stack: scope.navStack ?? [], at: Date.now() };
    // Keep the most recently used menus (integer keys iterate in numeric order, not insertion order).
    const ids = Object.keys(history).sort((a, b) => (history[a]!.at ?? 0) - (history[b]!.at ?? 0));
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_NAV_MESSAGES))) delete history[old];
    session.set(NAV_KEY, history);
    // The last page shown decides where the user's text goes (`page.onText`).
    if (this.app.pages.get(scope.view.id)?.textFn && typeof messageId === 'number') session.set(INPUT_KEY, { ...scope.view, messageId } satisfies TextInputState);
    else session.delete(INPUT_KEY);
  }
}

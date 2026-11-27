// Messages without an incoming update: sendTo / edit / withUser, broadcasts,
// inline results and Mini App answers, and the built-in scheduled tasks.
import type { Context } from 'grammy';
import type { InlineQueryResult } from 'grammy/types';
import { runBroadcast, type BroadcastResult } from '../broadcast';
import { normalizeParams, type ParamsInput } from '../callback';
import type { Page } from '../define';
import type { EasyTG } from '../engine';
import { EasyTGError, isChatUnreachable, isMessageNotFound, isTransient } from '../errors';
import { createProactiveContext, type SendTarget } from '../proactive';
import { sentBeforeError } from '../render';
import { sha256, toBase64Url } from '../platform/crypto';
import { DialogueStart, Redirect, type Awaitable, type Params } from '../types';
import type { RefreshPayload } from './delivery';
import { BROADCAST_TASK, DELETE_TASK, MAX_REDIRECTS, REFRESH_TASK, SEND_TASK, flows, userKey, type Flow } from './scope';
import type { BotLike, BroadcastLaterOptions, DeleteLaterOptions, BroadcastOptions, EditMessageTarget, InlineResultOptions, SendLaterOptions, WithUserArgs } from './types';

interface BroadcastBatchPayload {
  broadcast: string;
  batch: number;
  batches: number;
  targets: Array<number | SendTarget>;
  page: string;
  params: Record<string, string>;
  perSecond: number;
  concurrency?: number;
}

/** @internal */
export class Sending<C extends Context> {
  constructor(
    private readonly app: EasyTG<C>,
    private readonly prepareProactive: ((ctx: C) => Awaitable<void>) | undefined,
    private readonly emitProactiveErrors: boolean,
  ) {}

  async sendTo(bot: BotLike, target: number | SendTarget, page: Page<any, any, any> | string, params?: ParamsInput) {
    const ctx = await this.context(bot, typeof target === 'number' ? { chatId: target } : target);
    return this.reporting(ctx, 'sendTo', () =>
      this.asUser(ctx, () => this.app.open(ctx, typeof page === 'string' ? page : page.id, params, { mode: 'send' })),
    );
  }

  /** sendTo without error events (broadcast reports failures in its result). */
  private async deliverTo(bot: BotLike, target: number | SendTarget, pageId: string, params?: ParamsInput) {
    const ctx = await this.context(bot, typeof target === 'number' ? { chatId: target } : target);
    return this.asUser(ctx, () => this.app.open(ctx, pageId, params, { mode: 'send' }));
  }

  async edit(bot: BotLike, target: EditMessageTarget, page: Page<any, any, any> | string, params?: ParamsInput) {
    const ctx = await this.context(bot, target);
    const scope = this.app.scopes.get(ctx);
    scope.editTarget = { chatId: target.chatId, messageId: target.messageId };
    scope.noFallback = true;
    return this.reporting(ctx, 'edit', () =>
      this.asUser(ctx, () => this.app.open(ctx, typeof page === 'string' ? page : page.id, params, { mode: 'edit' })),
    );
  }

  async withUser<T>(bot: BotLike, target: number | SendTarget, fn: (args: WithUserArgs<C>) => Awaitable<T>): Promise<T> {
    const app = this.app;
    const userTarget = typeof target === 'number' ? { chatId: target, userId: target } : target;
    if (userTarget.userId === undefined) throw new EasyTGError('withUser needs a userId');
    const ctx = await this.context(bot, userTarget);
    return this.asUser(ctx, async () => {
      const session = await app.session(ctx);
      const userSession = await app.userSession(ctx);
      const result = await fn({ ctx, session, userSession, locale: app.localeOf(ctx), t: app.t(ctx), nav: app.nav(ctx), app });
      await app.flush(ctx);
      return result;
    });
  }

  /**
   * Run a proactive render in step with the user's own updates: share the
   * session of an update of this user that is being handled right now in this
   * process (e.g. `sendTo` from that update's handler), or else take the
   * user's lock, so neither overwrites the other's session changes.
   */
  private async asUser<T>(ctx: C, run: () => Promise<T>): Promise<T> {
    const key = userKey(ctx);
    const flow: Flow = { key, ctx, queues: new Set() };
    // Sharing the session of an update of this user (see context): it holds the lock.
    if (this.app.scopes.get(ctx).sharedWith) return flows.run(flow, run);
    const release = key !== undefined ? await this.app.pipeline.lockUser(key) : null;
    try {
      return await flows.run(flow, run);
    } finally {
      await release?.();
    }
  }

  private async reporting<T>(ctx: C, source: 'sendTo' | 'edit', run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (this.emitProactiveErrors) await this.app.emit('error', { error, ctx, source });
      throw error;
    }
  }

  private async context(bot: BotLike, target: SendTarget): Promise<C> {
    if (!bot.isInited()) await bot.init();
    const ctx = createProactiveContext(bot.api, bot.botInfo, target) as C;
    const key = userKey(ctx);
    // Called from inside this user's own update (a handler, a listener, a middleware, …),
    // or while one of their updates runs elsewhere in this process: share its session.
    const flow = flows.get();
    const live = key === undefined ? undefined : flow?.key === key && flow.ctx ? flow.ctx : this.app.pipeline.liveUpdate(key);
    if (live) this.app.scopes.get(ctx).sharedWith = live;
    await this.prepareProactive?.(ctx);
    return ctx;
  }

  broadcast(bot: BotLike, targets: Iterable<number | SendTarget>, page: Page<any, any, any>, options: BroadcastOptions<Params> = {}): Promise<BroadcastResult> {
    const { params, ...settings } = options;
    this.app.page(page); // fail fast if it isn't registered
    return runBroadcast(targets, (target) => this.deliverTo(bot, target, page.id, params), settings);
  }

  async broadcastLater(targets: Iterable<number | SendTarget>, page: Page<any, any, any>, options: BroadcastLaterOptions<Params> = {}) {
    const { params, batchSize = 100, perSecond = 25, concurrency, delayMs, at, botId } = options;
    this.app.page(page);
    const list = [...targets];
    const id = `_easytg:broadcast:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const start = at instanceof Date ? at.getTime() : at ?? Date.now() + (delayMs ?? 0);
    const batches = Math.ceil(list.length / batchSize);
    for (let batch = 0; batch < batches; batch++) {
      const payload: BroadcastBatchPayload = {
        broadcast: id,
        batch,
        batches,
        targets: list.slice(batch * batchSize, (batch + 1) * batchSize),
        page: page.id,
        params: normalizeParams(params),
        perSecond,
        concurrency,
      };
      // Spaced so the batches together keep to `perSecond`.
      await this.app.scheduler.schedule(BROADCAST_TASK, payload, { at: start + Math.round((batch * batchSize * 1000) / perSecond), id: `${id}:${batch}`, botId });
    }
    return { id, batches };
  }

  sendLater(target: number | SendTarget, page: Page<any, any, any> | string, options: SendLaterOptions<Params>) {
    const pageId = this.app.page(page).id;
    const { params, ...when } = options;
    return this.app.scheduler.schedule(SEND_TASK, { target, page: pageId, params: normalizeParams(params as ParamsInput) }, when);
  }

  deleteLater(target: Context | { chatId: number; botId?: number }, messageIds: number | number[], options: DeleteLaterOptions) {
    const ctx = 'update' in target ? target : undefined; // (a Context has a `chatId` getter too)
    const chatId = ctx ? ctx.chat?.id : (target as { chatId: number }).chatId;
    if (chatId === undefined) throw new EasyTGError('deleteLater: no chat');
    const botId = ctx ? ctx.me.id : (target as { botId?: number }).botId;
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    return this.app.scheduler.schedule(DELETE_TASK, { chatId, messageIds: ids }, { ...options, botId });
  }

  async inlineResult(ctx: C, page: Page<any, any, any>, options: InlineResultOptions<Params>): Promise<InlineQueryResult> {
    const app = this.app;
    const scope = app.scopes.get(ctx);
    try {
      let result = await app.views.renderPage(ctx, app.page(page), normalizeParams(options.params as ParamsInput));
      for (let depth = 0; result instanceof Redirect; depth++) {
        if (depth >= MAX_REDIRECTS) throw new EasyTGError(`Too many redirects (last: "${result.target}")`);
        result = await app.views.renderPage(ctx, app.page(result.target), result.params);
      }
      if (!result || result instanceof DialogueStart) throw new EasyTGError(`Page "${page.id}" has no content to show as an inline result`);
      const prepared = app.delivery.prepare(result);
      if (!prepared) throw new EasyTGError(`Page "${page.id}" has no content to show as an inline result`);
      if (prepared.chunks.length > 1) app.logger.warn(`Inline result "${page.id}": text too long, only the first part is shown`);
      await app.buttons.flush(scope); // stored buttons must exist before the result is sent
      await app.flush(ctx);

      const id = options.id ?? inlineResultId(page.id, options.params as ParamsInput);
      const text = prepared.chunks[0]!;
      const reply_markup = prepared.reply_markup.inline_keyboard.length ? prepared.reply_markup : undefined;
      const { title, description, thumbnailUrl } = options;
      if (prepared.rich) {
        // Inline mode sends no files: media in a rich page must already be on Telegram (file ids).
        return { type: 'article', id, title, description, thumbnail_url: thumbnailUrl, input_message_content: { rich_message: prepared.rich as never }, reply_markup };
      }
      const media = prepared.media;
      if (media) {
        if (media.type !== 'photo' || typeof media.source !== 'string') {
          throw new EasyTGError(`Inline result "${page.id}": only text and photo (file id or URL) pages can be inline results`);
        }
        const caption = { caption: text || undefined, ...(text ? (prepared.entities ? { caption_entities: prepared.entities } : { parse_mode: prepared.parse_mode }) : {}), reply_markup, title, description };
        return /^https?:\/\//i.test(media.source)
          ? { type: 'photo', id, photo_url: media.source, thumbnail_url: thumbnailUrl ?? media.source, ...caption }
          : { type: 'photo', id, photo_file_id: media.source, ...caption };
      }
      if (!text) throw new EasyTGError(`Inline result "${page.id}": a text page needs text`);
      return {
        type: 'article',
        id,
        title,
        description,
        thumbnail_url: thumbnailUrl,
        input_message_content: { message_text: text, ...(prepared.entities ? { entities: prepared.entities } : { parse_mode: prepared.parse_mode }), link_preview_options: prepared.link_preview_options },
        reply_markup,
      };
    } finally {
      scope.view = undefined;
    }
  }

  /** A page rendered for a user as an inline result, with buttons anyone in the target chat may press. */
  async renderAsInline(bot: BotLike, userId: number, page: Page<any, any, any>, options: InlineResultOptions<Params>) {
    const ctx = await this.context(bot, { chatId: userId, userId });
    this.app.scopes.get(ctx).inlineRender = true;
    return this.asUser(ctx, () => this.inlineResult(ctx, page, options));
  }

  /** The tasks behind `deleteLater`, `broadcastLater`, `refreshEveryMs` and `sendLater`. */
  defineTasks() {
    const app = this.app;
    app.scheduler.define(DELETE_TASK, async ({ payload, bot }) => {
      const { chatId, messageIds } = payload as { chatId: number; messageIds: number[] };
      try {
        await bot.api.deleteMessages(chatId, messageIds);
      } catch (error) {
        if (isTransient(error)) throw error; // retried by the scheduler
        // Already deleted, too old, or the bot left the chat: nothing left to do.
        if (!isMessageNotFound(error) && !isChatUnreachable(error)) app.logger.warn('deleteLater: could not delete messages', error);
      }
    });
    app.scheduler.define(
      BROADCAST_TASK,
      async ({ payload, bot, task }) => {
        const job = payload as BroadcastBatchPayload;
        // Claimed again: the first run outlived its lease (or its process died). Sending
        // the batch again would reach its recipients twice.
        if (task.attempts > 1) {
          app.logger.warn(`broadcastLater: batch ${job.batch + 1}/${job.batches} of ${job.broadcast} was started before; not sending it again`);
          return;
        }
        if (!app.pages.has(job.page)) throw new EasyTGError(`broadcastLater: page "${job.page}" is not registered`);
        const result = await runBroadcast(job.targets, (target) => this.deliverTo(bot, target, job.page, job.params), job);
        await app.emit('broadcastBatch', { broadcast: job.broadcast, batch: job.batch, batches: job.batches, result });
      },
      // A retry would send the whole batch again.
      { maxAttempts: 1 },
    );
    app.scheduler.define(REFRESH_TASK, async ({ payload, bot }) => {
      const { chatId, messageId, userId, threadId, allowedUsers, page, params } = payload as RefreshPayload;
      if (!app.pages.has(page)) return;
      // Showing another page in the message cancels this task, so it still shows this one.
      const ctx = await this.context(bot, { chatId, userId, threadId, allowedUsers });
      const scope = app.scopes.get(ctx);
      scope.editTarget = { chatId, messageId };
      scope.noFallback = true;
      scope.refreshing = true;
      // The render schedules the next refresh if it still asks for one; a deleted message stops it.
      await this.asUser(ctx, () => app.open(ctx, page, params, { mode: 'edit' }));
    });
    app.scheduler.define(SEND_TASK, async ({ payload, bot }) => {
      const { target, page, params } = payload as { target: number | SendTarget; page: string; params: Record<string, string> };
      try {
        await this.sendTo(bot, target, page, params);
      } catch (error) {
        if (isChatUnreachable(error)) return;
        // Part of the page went out already: a retry would send it twice.
        if (sentBeforeError(error)) return void app.logger.error('sendLater: the page was only partly sent', error);
        throw error; // retried
      }
    });
  }
}

/** A result id (≤ 64 bytes) that is the same for the same page and params. */
function inlineResultId(pageId: string, params: ParamsInput | undefined): string {
  const query = JSON.stringify(Object.entries(normalizeParams(params)).sort());
  return toBase64Url(sha256(`${pageId}|${query}`)).slice(0, 40);
}


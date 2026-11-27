// Getting content into the chat: send/edit (with cached file ids), the
// `deleteAfterMs` and `refreshEveryMs` tasks, answering and closing pressed menus.
import type { Context } from 'grammy';
import type { Message, ReplyKeyboardMarkup, ReplyKeyboardRemove } from 'grammy/types';
import type { EasyTG } from '../engine';
import type { ParseMode, TextTransform } from '../format';
import { isProactive, threadIdOf } from '../proactive';
import {
  deliver,
  prepareContent,
  pressedMessage,
  removeWithGroup,
  type Delivery as DeliveryOutcome,
  type DeliveryResult,
  type EphemeralSend,
  type PreparedContent,
} from '../render';
import { sha256, toBase64Url } from '../platform/crypto';
import type { DeliveryMode, PageContent } from '../types';
import { AUTODELETE_KEY, DAY_MS, DELETE_TASK, MAX_NAV_MESSAGES, REFRESH_TASK, scoped, type MessageKey, type UpdateScope } from './scope';
import type { MediaOptions } from './types';

/** What a `refreshEveryMs` task needs to render the page into its message again. */
export interface RefreshPayload {
  chatId: number;
  messageId: number;
  userId?: number;
  threadId?: number;
  allowedUsers?: number[];
  page: string;
  params: Record<string, string>;
}

/** @internal */
export class Delivery<C extends Context> {
  private readonly cacheFileIds: boolean;
  private readonly fileIdTtlMs: number;

  constructor(
    private readonly app: EasyTG<C>,
    private readonly parseMode: ParseMode,
    private readonly protectContent: boolean,
    media: MediaOptions,
    private readonly transformText?: TextTransform,
  ) {
    this.cacheFileIds = media.cacheFileIds ?? false;
    this.fileIdTtlMs = media.cacheTtlMs ?? 30 * DAY_MS;
  }

  /** Content prepared for sending with the app's parse mode and `protectContent`. */
  prepare(content: PageContent): PreparedContent | null {
    return prepareContent(content, this.parseMode, this.protectContent, this.transformText);
  }

  /** Send/edit content; stored buttons are persisted before the message goes out. */
  async deliverContent(
    ctx: C,
    content: PageContent,
    mode: DeliveryMode,
    sendMarkup?: ReplyKeyboardMarkup | ReplyKeyboardRemove,
  ): Promise<DeliveryOutcome | undefined> {
    const prepared = this.prepare(content);
    if (!prepared) return undefined;
    if (sendMarkup) {
      prepared.sendMarkup = sendMarkup;
      mode = 'send'; // reply keyboards can only come with a new message
    }
    const scope = this.app.scopes.get(ctx);
    await this.app.buttons.flush(scope);
    const delivery = await this.deliverCached(ctx, prepared, mode, scope);
    if (scope.view) scope.refreshEveryMs = content.refreshEveryMs;
    if (delivery?.sent.length && ctx.chat) {
      await this.app.emit('sent', { ctx, chatId: ctx.chat.id, messageIds: delivery.sent, page: scope.view?.id });
    }
    const chatId = ctx.chat?.id ?? scope.editTarget?.chatId;
    if (delivery && chatId !== undefined && !delivery.ephemeral) {
      // The message is out already: a failure here must not fail the page.
      await this.autoDelete(ctx, chatId, delivery, content.deleteAfterMs).catch((error) => {
        this.app.logger.error('deleteAfterMs: could not schedule or cancel the deletion', error);
      });
    }
    return delivery;
  }

  /** `deliver`, sending remembered file ids instead of URLs (`media.cacheFileIds`). */
  private async deliverCached(ctx: C, prepared: PreparedContent, mode: DeliveryMode, scope: UpdateScope) {
    const options = { fallbackToSend: !scope.noFallback };
    const media = prepared.media;
    const url = this.cacheFileIds && media && typeof media.source === 'string' && /^https?:\/\//i.test(media.source) ? media.source : undefined;
    if (!url) return deliver(this.app, ctx, prepared, mode, scope.editTarget, options);

    const storage = this.app.buttons.metaStorage;
    const key = scoped('fileid', this.app.scopes.botScope(ctx), media!.type, toBase64Url(sha256(url)).slice(0, 32));
    const cached = await storage.get(key);
    if (typeof cached === 'string') {
      try {
        return await deliver(this.app, ctx, { ...prepared, media: { ...media!, source: cached } }, mode, scope.editTarget, options);
      } catch (error) {
        if (!/file identifier|wrong file|file_id/i.test(String(error))) throw error;
        await storage.delete(key); // no longer valid: send the URL again
      }
    }
    const delivery = await deliver(this.app, ctx, prepared, mode, scope.editTarget, options);
    const fileId = delivery && delivery.result !== true ? sentFileId(delivery.result, media!.type) : undefined;
    if (fileId) await storage.set(key, fileId, this.fileIdTtlMs);
    return delivery;
  }

  /**
   * `deleteAfterMs`: schedule the deletion of what was just delivered. The
   * task is named after the message, so a later edit of the same message
   * replaces it (new `deleteAfterMs`) or cancels it (a page without one).
   */
  private async autoDelete(ctx: C, chatId: number, delivery: DeliveryOutcome, deleteAfterMs: number | undefined) {
    // Edits may return `true` instead of the message: then it's the message that was edited.
    const target = this.app.scopes.peek(ctx)?.editTarget?.messageId ?? ctx.callbackQuery?.message?.message_id;
    const edited = delivery.sent.length ? undefined : delivery.result === true ? target : delivery.result.message_id;
    const last = delivery.sent.at(-1) ?? edited;
    if (last === undefined) return;
    const id = `_easytg:del:${ctx.me.id}:${chatId}:${last}`;
    // Messages with a pending deletion, per user, so edits only cost a storage call when needed.
    const session = ctx.from ? await this.app.sessions.state(ctx) : undefined;
    const pending = session?.get<number[]>(AUTODELETE_KEY) ?? [];
    if (deleteAfterMs !== undefined) {
      // A page refreshing itself must not push its own deletion back: the first render scheduled it.
      if (this.app.scopes.peek(ctx)?.refreshing) return;
      const ids = delivery.sent.length ? delivery.sent : [edited!];
      await this.app.scheduler.schedule(DELETE_TASK, { chatId, messageIds: ids }, { delayMs: deleteAfterMs, botId: ctx.me.id, id });
      if (session && !pending.includes(last)) session.set(AUTODELETE_KEY, [...pending, last].slice(-MAX_NAV_MESSAGES));
    } else if (edited !== undefined && pending.includes(edited)) {
      await this.app.scheduler.cancel(id);
      session!.set(AUTODELETE_KEY, pending.filter((m) => m !== edited));
    }
  }

  /** `refreshEveryMs`: render the page into its message again later (one task per message). */
  async scheduleRefresh(ctx: C, delivered: DeliveryResult, sourceId: MessageKey | undefined) {
    // Ephemeral messages belong to one user's screen and may vanish: no refreshes, and a
    // shared message opened ephemerally keeps its own.
    if (typeof sourceId === 'string' || (delivered !== true && delivered.ephemeral_message_id !== undefined)) return;
    const scope = this.app.scopes.get(ctx);
    const every = scope.refreshEveryMs;
    const messageId = delivered === true ? sourceId : delivered.message_id;
    const chatId = ctx.chat?.id ?? scope.editTarget?.chatId;
    if (chatId === undefined) return;
    const idOf = (message: number) => `${REFRESH_TASK}:${ctx.me.id}:${chatId}:${message}`;
    try {
      // The message now shows something else (whoever navigated it), or moved to a new message:
      // a refresh scheduled for it must not bring the old page back.
      if (sourceId !== undefined && (!every || sourceId !== messageId)) await this.app.scheduler.cancel(idOf(sourceId));
      if (!every || !scope.view || messageId === undefined) return;
      const payload: RefreshPayload = {
        chatId,
        messageId,
        userId: ctx.from?.id,
        threadId: threadIdOf(ctx),
        allowedUsers: this.app.buttons.allowedUsers(ctx),
        page: scope.view.id,
        params: scope.view.params,
      };
      await this.app.scheduler.schedule(REFRESH_TASK, payload, { delayMs: every, id: idOf(messageId), botId: ctx.me.id });
    } catch (error) {
      if (every) this.app.logger.error('refreshEveryMs: could not schedule the refresh', error);
    }
  }

  /**
   * Whether this update's new messages go out as ephemeral messages (Bot API
   * 10.2), only for the user who acted. See `EasyTG.ephemeral`.
   */
  ephemeral(ctx: C, requested: boolean): EphemeralSend | undefined {
    const chat = ctx.chat;
    const from = ctx.from;
    if (!chat || !from || (chat.type !== 'group' && chat.type !== 'supergroup') || isProactive(ctx)) return undefined;
    const scope = this.app.scopes.get(ctx);
    const query = ctx.callbackQuery;
    const pressed = query?.message && query.message.date !== 0 ? (query.message as Message).ephemeral_message_id : undefined;
    const incoming = ctx.message?.ephemeral_message_id;
    if (!requested && !scope.ephemeral && pressed === undefined && incoming === undefined) return undefined;
    if (requested) scope.ephemeral = true;
    // The first ephemeral answer to a press on a normal message takes its place on the presser's screen.
    const replace = !!query && pressed === undefined && !scope.ephemeralReplaced;
    if (replace) scope.ephemeralReplaced = true;
    return {
      params: { receiver_user_id: from.id, ...(query ? { callback_query_id: query.id } : {}), ...(replace ? { replace_callback_query_message: true } : {}) },
      replyTo: incoming,
    };
  }

  /** Replace reply-keyboard buttons with the main menu (or remove them), with a short message. */
  async restoreKeyboard(ctx: C, text: string) {
    const app = this.app;
    const markup = app.menu ? app.menu.markup(app.localeOf(ctx), app.textsFor(ctx).closeMenu, app.t(ctx)) : { remove_keyboard: true as const };
    await this.deliverContent(ctx, { text, parseMode: 'plain' }, 'send', markup);
  }

  /** Answer the current callback query once; later calls are no-ops. */
  async answerCallback(ctx: C, options?: { text?: string; show_alert?: boolean }) {
    const scope = this.app.scopes.get(ctx);
    if (!ctx.callbackQuery || scope.answered) return;
    scope.answered = true;
    try {
      await ctx.answerCallbackQuery(options);
    } catch (error) {
      this.app.logger.debug('Failed to answer callback query', error);
    }
  }

  /** Delete the pressed message; if it's too old to delete, strip its keyboard. */
  async closeMessage(ctx: C) {
    const pressed = pressedMessage(ctx);
    if (pressed?.ephemeral) {
      await ctx.api
        .deleteEphemeralMessage(pressed.chatId!, pressed.ephemeral.receiverUserId, pressed.ephemeral.id)
        .catch((error: unknown) => this.app.logger.debug('Failed to delete an ephemeral message', error));
      return;
    }
    const message = ctx.callbackQuery?.message;
    if (!message && !ctx.callbackQuery?.inline_message_id) return;
    // Inline-mode messages can't be deleted by the bot: only strip the keyboard.
    if (message && (await removeWithGroup(this.app, ctx, message))) return;
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      this.app.logger.debug('Failed to remove keyboard', error);
    }
  }
}

/** The file id Telegram assigned to the media of a sent message. */
function sentFileId(message: Message, type: string): string | undefined {
  if (type === 'photo') return message.photo?.at(-1)?.file_id;
  const file = (message as unknown as Record<string, { file_id?: string } | undefined>)[type];
  return file?.file_id;
}

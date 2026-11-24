// Waiting in the chat: `app.stream` (drafts or a growing message) and loading
// indicators (chat actions, toasts, placeholder messages) around slow work.
import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { EasyTG } from '../engine';
import { EasyTGError, isNotModified } from '../errors';
import type { TextInput } from '../format';
import { threadIdOf } from '../proactive';
import type { Awaitable, LoadingOptions } from '../types';
import type { StreamOptions, StreamResult, StreamSource } from './types';

/** @internal */
export class Loading<C extends Context> {
  /** Streams with a stop button, by `chat:draft`. */
  private readonly streams = new Map<string, AbortController>();

  constructor(private readonly app: EasyTG<C>) {}

  /** The user pressed stop under a streamed draft. */
  stop(chatId: number, draftId: number) {
    this.streams.get(`${chatId}:${draftId}`)?.abort();
  }

  async stream(ctx: C, source: StreamSource, options: StreamOptions = {}): Promise<StreamResult> {
    const app = this.app;
    const chat = ctx.chat;
    if (!chat) throw new EasyTGError('app.stream needs a chat');
    const controller = new AbortController();
    const draft = chat.type === 'private';
    const interval = options.intervalMs ?? (draft ? 300 : 1000);
    const draftId = 1 + Math.floor(Math.random() * 2_000_000_000);
    const key = `${chat.id}:${draftId}`;
    const thread = threadIdOf(ctx);
    const stopButton = draft && options.stoppable ? { can_stop: true } : {};
    if (draft && options.stoppable) this.streams.set(key, controller);

    let text = '';
    let shown: string | undefined;
    let last = 0;
    let placeholder: Message | undefined;
    // Previews are plain text: half-written formatting would be refused (Telegram's limit is 4096).
    // Rich Markdown is forgiving, so `rich` previews are formatted (up to 32768 characters).
    const rich = !!options.rich;
    const limit = rich ? 32768 : 4096;
    const preview = () => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
    const show = async (force = false) => {
      if (text === shown || (!force && Date.now() - last < interval)) return;
      shown = text;
      last = Date.now();
      try {
        const body = preview();
        // Before the first word a draft without text shows "Thinking…", rich or not.
        if (draft && rich && body.trim()) await ctx.api.sendRichMessageDraft(chat.id, draftId, { markdown: body }, { message_thread_id: thread, ...stopButton });
        else if (draft) await ctx.api.sendMessageDraft(chat.id, draftId, body, { message_thread_id: thread, ...stopButton });
        else if (placeholder) await ctx.api.editMessageText(chat.id, placeholder.message_id, rich && body.trim() ? { markdown: body } : body || '…');
      } catch (error) {
        if (!isNotModified(error)) app.logger.debug('app.stream: preview update failed', error);
      }
    };

    let stopped = false;
    try {
      // Before the first word: "Thinking…" (a draft with no text), or a placeholder message in groups.
      if (draft) await show(true);
      else placeholder = await ctx.api.sendMessage(chat.id, '…', { message_thread_id: thread });
      const iterable = typeof source === 'function' ? source(controller.signal) : source;
      for await (const chunk of iterable) {
        if (controller.signal.aborted) break;
        text += chunk;
        await show();
      }
      stopped = controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted) {
        // The source failed before its first word: don't leave the "…" behind (text that came stays).
        if (placeholder && !text.trim()) await ctx.api.deleteMessage(chat.id, placeholder.message_id).catch(() => undefined);
        throw error;
      }
      stopped = true; // the source gave up because it was stopped
    } finally {
      this.streams.delete(key);
    }

    // Models often end with a space or a newline: not worth a line in the chat. `finish` gets the text as it came.
    const content = options.finish ? options.finish(text, { stopped }) : rich && text.trim() ? { rich: text.trim() } : { text: text.trim() };
    const scope = app.scopes.get(ctx);
    if (!placeholder) {
      const delivery = await app.delivery.deliverContent(ctx, content, 'send');
      return { text, stopped, result: delivery?.result };
    }
    // Groups: the final message takes the place of the growing one.
    const previous = scope.editTarget;
    scope.editTarget = { chatId: chat.id, messageId: placeholder.message_id, message: placeholder };
    try {
      const delivery = await app.delivery.deliverContent(ctx, content, 'edit');
      return { text, stopped, result: delivery?.result };
    } finally {
      scope.editTarget = previous;
    }
  }

  async withLoading<T>(ctx: C, job: () => Awaitable<T>, options: LoadingOptions): Promise<T> {
    const placeholder = { message: undefined as { chatId: number; messageId: number } | undefined };
    try {
      return await this.around(ctx, options, job, async (text) => {
        const delivery = await this.app.delivery.deliverContent(ctx, { text }, 'send');
        const chatId = ctx.chat?.id;
        if (delivery && delivery.result !== true && chatId !== undefined) placeholder.message = { chatId, messageId: delivery.result.message_id };
      });
    } finally {
      const message = placeholder.message;
      if (message) await ctx.api.deleteMessage(message.chatId, message.messageId).catch(() => {});
    }
  }

  /**
   * Loading for renders: the placeholder is what the page will replace.
   * `fresh`: always a new placeholder message (the pressed message may be
   * gone, e.g. a dialogue prompt).
   */
  async withPlaceholder<T>(ctx: C, options: LoadingOptions, job: () => Awaitable<T>, fresh = false): Promise<T> {
    const app = this.app;
    const scope = app.scopes.get(ctx);
    let restore: (() => Promise<unknown>) | undefined;
    try {
      return await this.around(ctx, options, job, async (text) => {
        const pressed = ctx.callbackQuery?.message as Message | undefined;
        if (pressed && !fresh) {
          // A text menu shows the placeholder (and no buttons, so it isn't pressed again); media gets a toast.
          if (pressed.text !== undefined) {
            restore = () =>
              ctx.api.editMessageText(pressed.chat.id, pressed.message_id, pressed.text!, { entities: pressed.entities, reply_markup: pressed.reply_markup });
            await app.delivery.deliverContent(ctx, { text }, 'edit');
          } else if (typeof text === 'string') await app.delivery.answerCallback(ctx, { text });
          return;
        }
        if (scope.editTarget && !fresh) {
          await app.delivery.deliverContent(ctx, { text }, 'edit'); // app.edit: in the message itself
          return;
        }
        const delivery = await app.delivery.deliverContent(ctx, { text }, 'send');
        const chatId = ctx.chat?.id;
        if (delivery && delivery.result !== true && chatId !== undefined) scope.placeholder = { chatId, messageId: delivery.result.message_id };
      });
    } catch (error) {
      // The render failed: don't leave a placeholder behind (a menu gets its buttons back).
      const placeholder = scope.placeholder;
      scope.placeholder = undefined;
      if (placeholder) await ctx.api.deleteMessage(placeholder.chatId, placeholder.messageId).catch(() => {});
      await restore?.().catch(() => {});
      throw error;
    }
  }

  private async around<T>(ctx: C, options: LoadingOptions, job: () => Awaitable<T>, showText: (text: TextInput) => Promise<void>): Promise<T> {
    const chatId = ctx.chat?.id ?? this.app.scopes.get(ctx).editTarget?.chatId;
    let interval: ReturnType<typeof setInterval> | undefined;
    let shown: Promise<void> | undefined;
    let done = false;
    const action = () => {
      if (options.action && chatId !== undefined) {
        void ctx.api.sendChatAction(chatId, options.action, { message_thread_id: threadIdOf(ctx) }).catch(() => {});
      }
    };
    const show = async () => {
      // The repeated action starts before anything is awaited, so `finally` always sees (and stops) it.
      if (options.action) {
        action();
        interval = setInterval(action, 4000); // Telegram shows an action for about 5 s
      }
      if (options.toast) await this.app.delivery.answerCallback(ctx, { text: options.toast });
      if (options.text !== undefined && !done) await showText(options.text);
    };
    const timer = setTimeout(() => {
      shown = show().catch((error) => this.app.logger.debug('Failed to show the loading indicator', error));
    }, options.afterMs ?? 500);
    try {
      return await job();
    } finally {
      done = true;
      clearTimeout(timer);
      clearInterval(interval);
      await shown; // the placeholder must exist before the result replaces it
    }
  }
}

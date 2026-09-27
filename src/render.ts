import type { Context } from 'grammy';
import type { InlineKeyboardButton, InlineKeyboardMarkup, LinkPreviewOptions, Message } from 'grammy/types';
import { EasyTGError, isMessageUnavailable, isNotModified } from './errors';
import { resolveText, type ParseMode } from './format';
import type { Logger } from './logger';
import { CAPTION_LIMIT, MESSAGE_LIMIT, splitText } from './split';
import type { DeliveryMode, ImageSource, KeyboardInput, KeyboardRow, PageContent } from './types';

export interface PreparedContent {
  /** Text split to Telegram's limits; one message per chunk. Always at least one (possibly empty). */
  chunks: string[];
  parse_mode?: 'HTML' | 'MarkdownV2';
  photo?: ImageSource;
  reply_markup: InlineKeyboardMarkup;
  link_preview_options?: LinkPreviewOptions;
}

export interface DeliveryHost {
  logger: Logger;
  /** New messages were sent for one piece of content (the keyboard is on the last one). */
  onSent(ctx: Context, messages: Message[]): Promise<void>;
  /** Ids of extra messages sent together with `messageId`, removed from tracking. */
  takeGroup(chatId: number, messageId: number): Promise<number[]>;
}

export type DeliveryResult = Message | true;

export interface Delivery {
  result: DeliveryResult;
  /** Ids of new messages sent. */
  sent: number[];
}

export function normalizeKeyboard(input: KeyboardInput | undefined): InlineKeyboardButton[][] {
  if (!input) return [];
  // Duck-typed, so an InlineKeyboard from another grammY copy works too.
  const rows = 'inline_keyboard' in input ? input.inline_keyboard : input;
  return rows
    .filter((row): row is KeyboardRow => Array.isArray(row))
    .map((row) => row.filter((button): button is InlineKeyboardButton => !!button))
    .filter((row) => row.length > 0);
}

export function prepareContent(content: PageContent, defaultMode: ParseMode): PreparedContent | null {
  const keyboard = normalizeKeyboard(content.keyboard);
  const resolved = resolveText(content.text, content.parseMode ?? defaultMode);
  if (!resolved.text && !content.photo && keyboard.length === 0) return null;

  const limits = content.photo ? [CAPTION_LIMIT, MESSAGE_LIMIT] : [MESSAGE_LIMIT];
  // MarkdownV2 is split as plain text: fine unless one entity spans a cut.
  const chunks = resolved.text ? splitText(resolved.text, resolved.parse_mode === 'HTML', limits) : [''];
  return {
    chunks,
    parse_mode: resolved.text ? resolved.parse_mode : undefined,
    photo: content.photo,
    reply_markup: { inline_keyboard: keyboard },
    link_preview_options: content.linkPreview === false ? { is_disabled: true } : undefined,
  };
}

/** The single place that picks sendMessage / sendPhoto / editMessageText / editMessageMedia / ... */
export async function deliver(host: DeliveryHost, ctx: Context, content: PreparedContent, mode: DeliveryMode): Promise<Delivery> {
  const resolved = mode === 'auto' ? (ctx.callbackQuery ? 'edit' : 'reply') : mode;
  if (resolved === 'edit') {
    const edited = await tryEdit(host, ctx, content);
    if (edited) return { result: edited, sent: [] };
  }
  return send(host, ctx, content, resolved === 'reply');
}

async function send(host: DeliveryHost, ctx: Context, content: PreparedContent, asReply: boolean): Promise<Delivery> {
  const { chunks, photo, parse_mode, link_preview_options } = content;
  if (!chunks[0] && !photo) {
    throw new EasyTGError('Cannot send a new message with only a keyboard: add `text` or `image`');
  }
  const replyTo = asReply && ctx.message
    ? { message_id: ctx.message.message_id, allow_sending_without_reply: true }
    : undefined;

  const messages: Message[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const reply_markup = i === chunks.length - 1 ? content.reply_markup : undefined;
    const reply_parameters = i === 0 ? replyTo : undefined;
    messages.push(
      i === 0 && photo
        ? await ctx.replyWithPhoto(photo, {
            caption: chunk || undefined,
            parse_mode: chunk ? parse_mode : undefined,
            reply_markup,
            reply_parameters,
          })
        : await ctx.reply(chunk, { parse_mode, reply_markup, reply_parameters, link_preview_options }),
    );
  }

  await host.onSent(ctx, messages);
  return { result: messages.at(-1)!, sent: messages.map((m) => m.message_id) };
}

/** Returns undefined when the message can't be edited and a new one should be sent. */
async function tryEdit(host: DeliveryHost, ctx: Context, content: PreparedContent): Promise<DeliveryResult | undefined> {
  const query = ctx.callbackQuery;
  if (!query) return undefined;

  // `date === 0` marks an inaccessible (too old) message.
  const message = query.message && query.message.date !== 0 ? (query.message as Message) : undefined;
  if (!message && !query.inline_message_id) return undefined;

  // Content that needs several messages replaces the pressed one.
  if (content.chunks.length > 1) {
    if (message) {
      await removeWithGroup(host, ctx, message);
      return undefined;
    }
    // Inline-mode messages have no chat to send more messages to: keep the first part.
    host.logger.warn('Text too long for an inline-mode message; showing only the first part');
    content = { ...content, chunks: [content.chunks[0]!] };
  }

  const text = content.chunks[0]!;
  const isTextMessage = !message || message.text !== undefined;
  const { reply_markup, parse_mode } = content;

  let result: DeliveryResult;
  try {
    if (!text && !content.photo) {
      result = await ctx.editMessageReplyMarkup({ reply_markup });
    } else if (content.photo) {
      const samePhoto = typeof content.photo === 'string' && message?.photo?.some((p) => p.file_id === content.photo);
      result = samePhoto
        ? await ctx.editMessageCaption({ caption: text, parse_mode, reply_markup })
        : await ctx.editMessageMedia(
            { type: 'photo', media: content.photo, caption: text || undefined, parse_mode },
            { reply_markup },
          );
    } else if (!isTextMessage) {
      // Media -> text can't be edited in place: replace the message.
      await removeWithGroup(host, ctx, message!);
      return undefined;
    } else {
      result = await ctx.editMessageText(text, { parse_mode, reply_markup, link_preview_options: content.link_preview_options });
    }
  } catch (error) {
    if (isNotModified(error)) {
      result = true;
    } else if (message && isMessageUnavailable(error)) {
      host.logger.debug('Message cannot be edited, sending a new one instead', error);
      await removeWithGroup(host, ctx, message); // don't leave the stale menu behind
      return undefined;
    } else {
      throw error;
    }
  }

  // The page fits in one message now: drop continuation messages of an earlier long render.
  if (message) await deleteMessages(host, ctx, message.chat.id, await host.takeGroup(message.chat.id, message.message_id));
  return result;
}

/** Delete a message together with the extra messages it was sent with. */
export async function removeWithGroup(host: DeliveryHost, ctx: Context, message: { chat: { id: number }; message_id: number }) {
  const extra = await host.takeGroup(message.chat.id, message.message_id);
  return deleteMessages(host, ctx, message.chat.id, [...extra, message.message_id]);
}

export async function deleteMessages(host: { logger: Logger }, ctx: Context, chatId: number, ids: number[]) {
  if (!ids.length) return true;
  try {
    if (ids.length === 1) await ctx.api.deleteMessage(chatId, ids[0]!);
    else await ctx.api.deleteMessages(chatId, ids);
    return true;
  } catch (error) {
    host.logger.debug('Failed to delete messages', error);
    return false;
  }
}

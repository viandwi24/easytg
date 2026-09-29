import type { Context } from 'grammy';
import type {
  ForceReply,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  LinkPreviewOptions,
  Message,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from 'grammy/types';
import { EasyTGError, isMessageUnavailable, isNotModified } from './errors';
import { resolveText, type ParseMode } from './format';
import type { Logger } from './logger';
import { threadIdOf } from './proactive';
import { CAPTION_LIMIT, MESSAGE_LIMIT, splitText, visibleLength } from './split';
import type { AlbumItem, CopySource, DeliveryMode, InvoiceContent, KeyboardInput, KeyboardRow, MediaSource, MediaType, PageContent } from './types';

const MEDIA_TYPES: MediaType[] = ['photo', 'video', 'animation', 'document', 'audio'];

export interface PreparedContent {
  /** Text split to Telegram's limits; one message per chunk. Always at least one (possibly empty). */
  chunks: string[];
  parse_mode?: 'HTML' | 'MarkdownV2';
  media?: { type: MediaType; source: MediaSource };
  album?: AlbumItem[];
  /** The first chunk is the album's caption (only when there is no keyboard). */
  albumCaption?: boolean;
  copy?: CopySource;
  invoice?: InvoiceContent;
  reply_markup: InlineKeyboardMarkup;
  /** Replaces the inline keyboard on new messages (reply keyboards can't be edited in). */
  sendMarkup?: ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply;
  link_preview_options?: LinkPreviewOptions;
  protect_content?: boolean;
}

/** The message to edit: from a button press, or given explicitly (`app.edit`). */
export interface EditTarget {
  chatId?: number;
  messageId?: number;
  inlineMessageId?: string;
  /** The message as Telegram sent it with the button press; unknown for `app.edit`. */
  message?: Message;
}

/** What a sent message is known by. Copies only return their id and chat. */
export type SentMessage = Pick<Message, 'message_id' | 'chat'>;

export interface DeliveryHost {
  logger: Logger;
  /**
   * When a page without media replaces a media message: `replace` deletes the
   * media message, `keep` leaves it (only its buttons are removed).
   */
  mediaToText: 'replace' | 'keep';
  /** New messages were sent for one piece of content (the keyboard is on the last one). */
  onSent(ctx: Context, messages: SentMessage[]): Promise<void>;
  /** Ids of extra messages sent together with `messageId`, removed from tracking. */
  takeGroup(ctx: Context, chatId: number, messageId: number): Promise<number[]>;
}

export type DeliveryResult = Message | true;

export interface Delivery {
  result: DeliveryResult;
  /** Ids of new messages sent. */
  sent: number[];
}

export function normalizeKeyboard(input: KeyboardInput | false | null | undefined): InlineKeyboardButton[][] {
  if (!input) return [];
  // Duck-typed, so an InlineKeyboard from another grammY copy works too.
  const rows = 'inline_keyboard' in input ? input.inline_keyboard : input;
  return rows
    .filter((row): row is KeyboardRow => Array.isArray(row))
    .map((row) => row.filter((button): button is InlineKeyboardButton => !!button))
    .filter((row) => row.length > 0);
}

export function prepareContent(content: PageContent, defaultMode: ParseMode, protect = false): PreparedContent | null {
  const keyboard = normalizeKeyboard(content.keyboard);
  const resolved = resolveText(content.text, content.parseMode ?? defaultMode);

  const kinds = [
    ...MEDIA_TYPES.filter((type) => content[type] !== undefined),
    ...(content.album ? ['album'] : []),
    ...(content.copy ? ['copy'] : []),
    ...(content.invoice ? ['invoice'] : []),
  ];
  if (kinds.length > 1) {
    throw new EasyTGError(`Content can have only one of photo, video, animation, document, audio, album, copy or invoice (got ${kinds.join(', ')})`);
  }
  if (content.invoice) {
    if (resolved.text) throw new EasyTGError("Invoices can't have text: use invoice.title and invoice.description");
    if (keyboard.length && !(keyboard[0]![0] as { pay?: boolean } | undefined)?.pay) throw new EasyTGError('The first button of an invoice keyboard must be nav.pay(...)');
    return {
      chunks: [''],
      invoice: content.invoice,
      reply_markup: { inline_keyboard: keyboard },
      protect_content: content.protectContent ?? protect ? true : undefined,
    };
  }
  const mediaType = MEDIA_TYPES.find((type) => content[type] !== undefined);
  const media = mediaType ? { type: mediaType, source: content[mediaType]! } : undefined;
  const { album, copy } = content;
  if (album && (album.length < 2 || album.length > 10)) throw new EasyTGError(`An album needs 2 to 10 items (got ${album.length})`);
  if (album && keyboard.length && !resolved.text) {
    throw new EasyTGError("An album with a keyboard needs text: albums can't carry buttons, so the text message carries them");
  }
  if (!resolved.text && !media && !album && !copy && keyboard.length === 0) return null;

  const albumCaption = !!album && keyboard.length === 0;
  const limits = media || copy || albumCaption ? [CAPTION_LIMIT, MESSAGE_LIMIT] : [MESSAGE_LIMIT];
  // MarkdownV2 is split as plain text: fine unless one entity spans a cut.
  const chunks = resolved.text ? splitText(resolved.text, resolved.parse_mode === 'HTML', limits, resolved.parse_mode === 'MarkdownV2') : [''];
  return {
    chunks,
    parse_mode: resolved.text ? resolved.parse_mode : undefined,
    media,
    album,
    albumCaption,
    copy,
    reply_markup: { inline_keyboard: keyboard },
    link_preview_options: content.linkPreview === false ? { is_disabled: true } : undefined,
    protect_content: content.protectContent ?? protect ? true : undefined,
  };
}

/** The message whose button was pressed, as an edit target. */
export function pressedMessage(ctx: Context): EditTarget | undefined {
  const query = ctx.callbackQuery;
  if (!query) return undefined;
  if (query.inline_message_id) return { inlineMessageId: query.inline_message_id };
  // `date === 0` marks an inaccessible (too old) message.
  if (!query.message || query.message.date === 0) return undefined;
  const message = query.message as Message;
  return { chatId: message.chat.id, messageId: message.message_id, message };
}

/**
 * The single place that picks sendMessage / sendPhoto / copyMessage /
 * editMessageText / editMessageMedia / …  With `fallbackToSend: false`, an
 * edit that isn't possible returns undefined instead of sending.
 */
export async function deliver(
  host: DeliveryHost,
  ctx: Context,
  content: PreparedContent,
  mode: DeliveryMode,
  target?: EditTarget,
  options: { fallbackToSend?: boolean } = {},
): Promise<Delivery | undefined> {
  const resolved = mode === 'auto' ? (ctx.callbackQuery ? 'edit' : 'reply') : mode;
  if (resolved === 'edit') {
    const editTarget = target ?? pressedMessage(ctx);
    if (editTarget) {
      const edited = await tryEdit(host, ctx, content, editTarget, options.fallbackToSend !== false);
      if (edited) return { result: edited, sent: [] };
    }
    if (options.fallbackToSend === false) return undefined;
  }
  return send(host, ctx, content, resolved === 'reply');
}

/** Messages that went out before a delivery failed half-way, by error. */
const partialSends = new WeakMap<object, number[]>();

/**
 * Ids of the messages that were sent before `error` interrupted a delivery
 * of several messages (a long text, an album with a keyboard). Retrying the
 * whole delivery would send them twice.
 */
export function sentBeforeError(error: unknown): number[] | undefined {
  return typeof error === 'object' && error !== null ? partialSends.get(error) : undefined;
}

async function send(host: DeliveryHost, ctx: Context, content: PreparedContent, asReply: boolean): Promise<Delivery> {
  const messages: SentMessage[] = [];
  try {
    return await sendAll(host, ctx, content, asReply, messages);
  } catch (error) {
    if (messages.length && typeof error === 'object' && error !== null) partialSends.set(error, messages.map((m) => m.message_id));
    throw error;
  }
}

async function sendAll(host: DeliveryHost, ctx: Context, content: PreparedContent, asReply: boolean, messages: SentMessage[]): Promise<Delivery> {
  const { chunks, media, album, copy, invoice, parse_mode, link_preview_options, protect_content } = content;
  if (invoice) {
    const chat = ctx.chat;
    if (!chat) throw new EasyTGError('invoice needs a chat to send to');
    const { title, description, payload, currency, prices, providerToken, options } = invoice;
    const replyTo = asReply && ctx.message ? { message_id: ctx.message.message_id, allow_sending_without_reply: true } : undefined;
    const message = await ctx.api.sendInvoice(chat.id, title, description, payload, currency, prices, {
      ...options,
      provider_token: providerToken,
      reply_markup: content.reply_markup.inline_keyboard.length ? content.reply_markup : undefined,
      reply_parameters: replyTo,
      protect_content,
      message_thread_id: threadIdOf(ctx),
    });
    await host.onSent(ctx, [message]);
    return { result: message, sent: [message.message_id] };
  }
  if (!chunks[0] && !media && !album && !copy) {
    throw new EasyTGError('Cannot send a new message with only a keyboard: add `text` or media');
  }
  let replyTo = asReply && ctx.message ? { message_id: ctx.message.message_id, allow_sending_without_reply: true } : undefined;

  let textChunks = chunks;

  if (album) {
    const caption = content.albumCaption ? chunks[0] : undefined;
    const items = album.map((item, i) =>
      i === 0 && caption ? { type: item.type, media: item.media, caption, parse_mode } : { type: item.type, media: item.media },
    );
    messages.push(
      ...(await ctx.replyWithMediaGroup(items as Parameters<Context['replyWithMediaGroup']>[0], { reply_parameters: replyTo, protect_content })),
    );
    replyTo = undefined;
    textChunks = chunks.slice(caption !== undefined ? 1 : 0).filter(Boolean);
  }

  if (copy) {
    // The copy carries the first chunk as its caption (or keeps its own caption without text).
    const chat = ctx.chat;
    if (!chat) throw new EasyTGError('copy needs a chat to copy into');
    const caption = chunks[0] || undefined;
    const rest = chunks.slice(1);
    const { message_id } = await ctx.api.copyMessage(chat.id, copy.fromChatId, copy.messageId, {
      caption,
      parse_mode: caption ? parse_mode : undefined,
      reply_markup: rest.length ? undefined : (content.sendMarkup ?? content.reply_markup),
      reply_parameters: replyTo,
      protect_content,
      message_thread_id: threadIdOf(ctx),
    });
    messages.push({ message_id, chat });
    replyTo = undefined;
    textChunks = rest;
  }

  for (const [i, chunk] of textChunks.entries()) {
    const reply_markup = i === textChunks.length - 1 ? (content.sendMarkup ?? content.reply_markup) : undefined;
    const reply_parameters = i === 0 ? replyTo : undefined;
    messages.push(
      i === 0 && media
        ? await sendMedia(ctx, media.type, media.source, {
            caption: chunk || undefined,
            parse_mode: chunk ? parse_mode : undefined,
            reply_markup,
            reply_parameters,
            protect_content,
          })
        : await ctx.reply(chunk, { parse_mode, reply_markup, reply_parameters, link_preview_options, protect_content }),
    );
  }

  await host.onSent(ctx, messages);
  return { result: messages.at(-1)! as Message, sent: messages.map((m) => m.message_id) };
}

type MediaOptions = Parameters<Context['replyWithPhoto']>[1];

function sendMedia(ctx: Context, type: MediaType, source: MediaSource, options: MediaOptions) {
  switch (type) {
    case 'photo':
      return ctx.replyWithPhoto(source, options);
    case 'video':
      return ctx.replyWithVideo(source, options);
    case 'animation':
      return ctx.replyWithAnimation(source, options);
    case 'document':
      return ctx.replyWithDocument(source, options);
    case 'audio':
      return ctx.replyWithAudio(source, options);
  }
}

/** The file ids a message's media of `type` is known by (all sizes, for photos). */
function mediaFileIds(message: Message | undefined, type: MediaType): string[] {
  if (!message) return [];
  if (type === 'photo') return message.photo?.map((p) => p.file_id) ?? [];
  const file = message[type];
  return file ? [file.file_id] : [];
}

/** Edit calls for a chat message or an inline-mode message. */
function editor(ctx: Context, target: EditTarget) {
  const { api } = ctx;
  const inline = target.inlineMessageId;
  const chatId = target.chatId!;
  const messageId = target.messageId!;
  type TextOther = Parameters<typeof api.editMessageText>[3];
  type CaptionOther = Parameters<typeof api.editMessageCaption>[2];
  type Media = Parameters<typeof api.editMessageMedia>[2];
  type MediaOther = Parameters<typeof api.editMessageMedia>[3];
  type MarkupOther = Parameters<typeof api.editMessageReplyMarkup>[2];
  return {
    text: (text: string, other: TextOther) =>
      inline ? api.editMessageTextInline(inline, text, other) : api.editMessageText(chatId, messageId, text, other),
    caption: (other: CaptionOther) =>
      inline ? api.editMessageCaptionInline(inline, other) : api.editMessageCaption(chatId, messageId, other),
    media: (media: Media, other: MediaOther) =>
      inline ? api.editMessageMediaInline(inline, media, other) : api.editMessageMedia(chatId, messageId, media, other),
    markup: (other: MarkupOther) =>
      inline ? api.editMessageReplyMarkupInline(inline, other) : api.editMessageReplyMarkup(chatId, messageId, other),
  };
}

/**
 * Returns undefined when the message can't be edited and a new one should be
 * sent. The old message is only removed when `replace` is true, i.e. when a new
 * one will actually take its place (`app.edit` never sends).
 */
async function tryEdit(
  host: DeliveryHost,
  ctx: Context,
  content: PreparedContent,
  target: EditTarget,
  replace: boolean,
): Promise<DeliveryResult | undefined> {
  const { message } = target;
  const giveUp = async () => {
    if (replace) await replacePressed(host, ctx, target);
    return undefined;
  };
  const inline = !!target.inlineMessageId;
  if (!inline && (target.chatId === undefined || target.messageId === undefined)) return undefined;

  // Albums, copies and invoices can't be edited into a message, and neither can
  // content that needs several messages: they replace the pressed one.
  if (content.album || content.copy || content.invoice) {
    if (inline) throw new EasyTGError(`${content.album ? 'Albums' : content.copy ? 'Copies' : 'Invoices'} can't be shown in inline-mode messages`);
    return giveUp();
  }
  if (content.chunks.length > 1) {
    if (!inline) return giveUp();
    // Inline-mode messages have no chat to send more messages to: keep the first part.
    host.logger.warn('Text too long for an inline-mode message; showing only the first part');
    content = { ...content, chunks: [content.chunks[0]!] };
  }

  const edit = editor(ctx, target);
  const text = content.chunks[0]!;
  const { reply_markup, parse_mode, media } = content;
  // Unknown for `app.edit`: then text edits fall back to caption edits.
  const isTextMessage = message ? message.text !== undefined : undefined;

  let result: DeliveryResult;
  // Only the buttons change: the text (and any continuation messages before it) stays.
  const markupOnly = !text && !media;
  try {
    if (markupOnly) {
      result = await edit.markup({ reply_markup });
    } else if (media) {
      // Same file already shown: only the caption and buttons change.
      const sameFile = typeof media.source === 'string' && mediaFileIds(message, media.type).includes(media.source);
      result = sameFile
        ? await edit.caption({ caption: text, parse_mode, reply_markup })
        : await edit.media(
            { type: media.type, media: media.source, caption: text || undefined, parse_mode } as Parameters<typeof edit.media>[0],
            { reply_markup },
          );
    } else if (isTextMessage === false) {
      // Media -> text can't be edited in place.
      return giveUp();
    } else {
      try {
        result = await edit.text(text, { parse_mode, reply_markup, link_preview_options: content.link_preview_options });
      } catch (error) {
        if (isTextMessage !== undefined || !String(error).includes('no text in the message')) throw error;
        // `app.edit` on a media message: update its caption instead, if the text fits a caption.
        if (visibleLength(text, parse_mode === 'HTML') > CAPTION_LIMIT) return giveUp();
        result = await edit.caption({ caption: text, parse_mode, reply_markup });
      }
    }
  } catch (error) {
    if (isNotModified(error)) {
      result = true;
    } else if (!inline && isMessageUnavailable(error)) {
      host.logger.debug('Message cannot be edited, sending a new one instead', error);
      if (replace) await replacePressed(host, ctx, target); // don't leave the stale menu behind
      return undefined;
    } else {
      throw error;
    }
  }

  // The page fits in one message now: drop continuation messages of an earlier long render.
  if (!inline && !markupOnly) await deleteMessages(host, ctx, target.chatId!, await host.takeGroup(ctx, target.chatId!, target.messageId!));
  return result;
}

/**
 * A new message takes over from the pressed one: delete it (with its group),
 * or, for media with `mediaToText: 'keep'`, only remove its buttons.
 */
async function replacePressed(host: DeliveryHost, ctx: Context, target: EditTarget) {
  if (target.chatId === undefined || target.messageId === undefined) return;
  const isMedia = !!target.message && target.message.text === undefined;
  if (isMedia && host.mediaToText === 'keep') {
    try {
      await ctx.api.editMessageReplyMarkup(target.chatId, target.messageId, { reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      host.logger.debug('Failed to remove buttons', error);
    }
    return;
  }
  await removeWithGroup(host, ctx, { chat: { id: target.chatId }, message_id: target.messageId });
}

/** Delete a message together with the extra messages it was sent with. */
export async function removeWithGroup(host: DeliveryHost, ctx: Context, message: { chat: { id: number }; message_id: number }) {
  const extra = await host.takeGroup(ctx, message.chat.id, message.message_id);
  return deleteMessages(host, ctx, message.chat.id, [...extra, message.message_id]);
}

export async function deleteMessages(host: { logger: Logger }, ctx: Context, chatId: number, ids: number[]) {
  if (!ids.length) return true;
  try {
    if (ids.length === 1) await ctx.api.deleteMessage(chatId, ids[0]!);
    // deleteMessages takes at most 100 ids per call.
    else for (let i = 0; i < ids.length; i += 100) await ctx.api.deleteMessages(chatId, ids.slice(i, i + 100));
    return true;
  } catch (error) {
    host.logger.debug('Failed to delete messages', error);
    return false;
  }
}

import { GrammyError } from 'grammy';

/** Error thrown for developer mistakes (invalid ids, oversized callback data, ...). */
export class EasyTGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EasyTGError';
  }
}

/** Thrown by a page's `.params(parse)`: the incoming params are invalid. Shown to users as "page not found". */
export class InvalidParamsError extends EasyTGError {
  constructor(message = 'Invalid params') {
    super(message);
    this.name = 'InvalidParamsError';
  }
}

function describe(error: unknown): string {
  if (error instanceof GrammyError) return error.description;
  return error instanceof Error ? error.message : String(error);
}

/** Telegram refused an edit because the new content equals the old one. */
export function isNotModified(error: unknown): boolean {
  return describe(error).includes('message is not modified');
}

/** The target message no longer exists or can't be edited/replied to anymore. */
export function isMessageUnavailable(error: unknown): boolean {
  const text = describe(error);
  return (
    text.includes('message to edit not found') ||
    text.includes("message can't be edited") ||
    text.includes('message to delete not found') ||
    text.includes("message can't be deleted") ||
    text.includes('MESSAGE_ID_INVALID') ||
    text.includes('there is no text in the message to edit') ||
    text.includes('there is no media in the message to edit') ||
    text.includes('there is no caption in the message to edit')
  );
}

/** The chat can't be messaged anymore: the user blocked the bot, deleted their account, or the bot left the chat. */
export function isBlockedByUser(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 403 || error.description.includes('chat not found'));
}

/** The message to edit or delete doesn't exist (anymore). */
export function isMessageNotFound(error: unknown): boolean {
  const text = describe(error);
  return text.includes('message to edit not found') || text.includes('message to delete not found') || text.includes('MESSAGE_ID_INVALID');
}

/** Seconds Telegram asks to wait (HTTP 429 "Too Many Requests"), or undefined for other errors. */
export function retryAfter(error: unknown): number | undefined {
  return error instanceof GrammyError && error.error_code === 429 ? (error.parameters.retry_after ?? 1) : undefined;
}

/** The callback query was already answered or expired. */
export function isQueryExpired(error: unknown): boolean {
  return describe(error).includes('query is too old') || describe(error).includes('query ID is invalid');
}

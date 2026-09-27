import { GrammyError } from 'grammy';

/** Error thrown for developer mistakes (invalid ids, oversized callback data, ...). */
export class EasyTGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EasyTGError';
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

/** The callback query was already answered or expired. */
export function isQueryExpired(error: unknown): boolean {
  return describe(error).includes('query is too old') || describe(error).includes('query ID is invalid');
}

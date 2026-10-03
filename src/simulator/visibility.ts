import type { SimMessage } from './index';

/**
 * What a user sees of a chat: ephemeral messages only reach their receiver,
 * and a message an ephemeral one replaced is gone from that receiver's screen
 * only. Without a user: everything.
 */
export function visibleTo(messages: SimMessage[], userId: number | undefined): SimMessage[] {
  if (userId === undefined) return messages;
  return messages.filter((m) => (m.receiver === undefined || m.receiver === userId) && !m.hiddenFor?.includes(userId));
}

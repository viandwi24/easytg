// The testing kit and the Telegram error helpers.
import { describe, expect, test } from 'bun:test';
import { isChatUnreachable, isMessageNotFound, retryAfterMs } from '../src';
import { createTestBot, telegramError } from '../src/testing';

describe('4. testing kit', () => {
  test('copy/forward calls get realistic results; bot identity is configurable', async () => {
    const t = createTestBot({ botInfo: { id: 42, username: 'custom_bot' } });
    expect(t.bot.botInfo).toMatchObject({ id: 42, username: 'custom_bot' });
    const copy = await t.bot.api.copyMessage(1, 2, 3);
    expect(copy).toEqual({ message_id: expect.any(Number) });
    const many = await t.bot.api.copyMessages(1, 2, [3, 4, 5]);
    expect(many).toHaveLength(3);
    const forwarded = await t.bot.api.forwardMessage(1, 2, 3);
    expect(forwarded.message_id).toBeNumber();
  });
});

describe('11. error helpers', () => {
  test('classify common Telegram errors', () => {
    expect(isChatUnreachable(telegramError('Forbidden: bot was blocked by the user', { code: 403 }))).toBe(true);
    expect(isChatUnreachable(telegramError('Bad Request: chat not found'))).toBe(true);
    expect(isChatUnreachable(telegramError('Bad Request: message is not modified'))).toBe(false);
    expect(isMessageNotFound(telegramError('Bad Request: message to delete not found'))).toBe(true);
    expect(retryAfterMs(telegramError('Too Many Requests', { code: 429, retryAfter: 5 }))).toBe(5000);
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
  });
});

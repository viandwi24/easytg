// Built-in middlewares.
import { describe, expect, test } from 'bun:test';
import { EasyTG, page, requireChatAdmin, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

describe('requireChatAdmin', () => {
  test('only admins pass in groups; private chats pass', async () => {
    const { app, press, responders, find } = setup();
    responders.getChatMember = (p) => ({ status: p.user_id === 1 ? 'administrator' : 'member', user: user(p.user_id) });
    const views: string[] = [];
    app.on('pageView', ({ page }) => void views.push(page));
    app.register(page('settings').use(requireChatAdmin()).render(() => ({ text: 'settings' })));
    await press('p|settings', { userId: 2, chatType: 'group' });
    expect(find('answerCallbackQuery').at(-1)!.payload.text).toBe(app.texts.adminOnly);
    await press('p|settings', { userId: 1, chatType: 'group', messageId: 501 });
    await press('p|settings', { userId: 2, messageId: 502 });
    expect(views).toEqual(['settings', 'settings']);
  });
});

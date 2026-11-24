// Observability: update and pageView events.
import { describe, expect, test } from 'bun:test';
import { EasyTG, page, type EasyTGOptions, type EasyTGEvents } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  return { ...t, app };
}

describe('observability', () => {
  test('update and pageView events carry timings and outcomes', async () => {
    const { app, bot, message, press } = setup({ antiSpam: { limit: 2, warn: false } });
    app.register(page('home').render(() => ({ text: 'home' })));
    const updates: EasyTGEvents['update'][] = [];
    const views: EasyTGEvents['pageView'][] = [];
    app.on('update', (e) => void updates.push(e));
    app.on('pageView', (e) => void views.push(e));
    bot.on('message', () => undefined);
    await press('p|home');
    await message('hi');
    await message('flood');
    expect(updates.map((u) => u.outcome)).toEqual(['easytg', 'next', 'limited']);
    expect(updates.every((u) => u.durationMs >= 0)).toBe(true);
    expect(views[0]).toMatchObject({ page: 'home', chatId: 7, userId: 7, mode: 'edit' });
    expect(views[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

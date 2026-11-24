// Redirect loops, and broadcast batches claimed twice.
import { describe, expect, setSystemTime, test } from 'bun:test';
import { EasyTG, MemoryStorage, dialogue, page, type EasyTGOptions } from '../src';
import { createTestBot } from '../src/testing';

function setup(options: EasyTGOptions = {}) {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, ...options, buttons: { doubleTapMs: 0, ...options.buttons } });
  t.bot.use(app);
  const button = (label: string) =>
    t.calls
      .filter((c) => c.payload.reply_markup?.inline_keyboard)
      .at(-1)!
      .payload.reply_markup.inline_keyboard.flat()
      .find((b: { text: string }) => b.text.includes(label))!.callback_data as string;
  return { ...t, app, button };
}

/** Run the tasks due `ms` from now. */
async function later(app: EasyTG, bot: Parameters<EasyTG['runDueTasks']>[0], ms: number) {
  setSystemTime(new Date(Date.now() + ms));
  try {
    await app.runDueTasks(bot);
  } finally {
    setSystemTime();
  }
}

describe('loops and leases', () => {
  test('a page and a dialogue that finishes at once redirecting to each other are stopped', async () => {
    const errors: unknown[] = [];
    const { app, press } = setup();
    app.on('error', ({ error }) => void errors.push(error));
    const d = dialogue('d')
      .steps([])
      .onFinish(({ nav }) => nav.redirect('p'));
    const p = page('p').render(({ nav }) => nav.startDialogue(d));
    app.register(p, d);
    await press('p|p');
    expect(String(errors[0])).toMatch(/Too many redirects/);
  });

  test('a broadcastLater batch claimed again is not sent twice', async () => {
    const { app, bot, find } = setup({ scheduler: { leaseMs: 1000 } });
    app.register(page('news').render(() => ({ text: 'news' })));
    await app.broadcastLater([1, 2], page('news'), { perSecond: 1000, botId: 1 });
    const storage = (app as unknown as { scheduler: { store: MemoryStorage } }).scheduler.store;
    await storage.claimTasks(Date.now() + 10, 10, 1); // a process that died holding it
    await later(app, bot, 5000);
    expect(find('sendMessage')).toEqual([]);
  });
});

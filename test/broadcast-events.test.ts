import { describe, expect, test } from 'bun:test';
import { EasyTG, dialogue, page, type EasyTGEvents } from '../src';
import { createTestBot, telegramError } from '../src/testing';

function setup() {
  const t = createTestBot();
  const app = new EasyTG({ logger: false, buttons: { doubleTapMs: 0 } });
  t.bot.use(app);
  return { ...t, app };
}

describe('broadcast', () => {
  test('personalised per recipient, paced, with blocked users and retries reported', async () => {
    const t = setup();
    const news = page<{ id: string }>('news').render(({ params, session }) => ({
      text: `Hi ${session.get<string>('name') ?? 'there'}, news #${params.id}`,
    }));
    t.app.register(news);
    t.bot.command('name', async (ctx) => (await t.app.session(ctx)).set('name', 'Ann'));
    await t.message('/name', { userId: 1 });

    let rateLimited = false;
    t.responders.sendMessage = (p) => {
      if (p.chat_id === 3) return telegramError('Forbidden: bot was blocked by the user', { code: 403 });
      if (p.chat_id === 4 && !rateLimited) return (rateLimited = true), telegramError('Too Many Requests', { code: 429, retryAfter: 0 });
      if (p.chat_id === 5) return telegramError('Bad Request: something else');
      return { message_id: 1, date: 1, chat: { id: p.chat_id, type: 'private' }, text: p.text };
    };

    const progress: number[] = [];
    const started = Date.now();
    const result = await t.app.broadcast(t.bot, [1, 2, 3, 4, 5], news, {
      params: { id: '7' },
      perSecond: 50,
      onProgress: (p) => void progress.push(p.sent + p.blocked + p.failed),
    });

    expect(result).toMatchObject({ total: 5, sent: 3, blocked: 1, failed: 1, blockedChats: [3], aborted: false });
    expect(result.failures[0]!.target).toBe(5);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80); // ~20ms apart at 50/s
    const texts = t.find('sendMessage').map((c) => [c.payload.chat_id, c.payload.text]);
    expect(texts).toContainEqual([1, 'Hi Ann, news #7']);
    expect(texts).toContainEqual([2, 'Hi there, news #7']);
    expect(texts.filter(([chat]) => chat === 4)).toHaveLength(2); // retried after the 429
  });

  test('can be stopped with an AbortSignal', async () => {
    const t = setup();
    const ping = page('ping').render(() => ({ text: 'ping' }));
    t.app.register(ping);
    const controller = new AbortController();
    const result = await t.app.broadcast(t.bot, [1, 2, 3, 4], ping, {
      perSecond: 1000,
      concurrency: 1, // with more workers, sends already under way still finish
      onProgress: (p) => void (p.sent === 2 && controller.abort()),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ sent: 2, aborted: true });
  });
});

describe('analytics events', () => {
  test('pageView, dialogueStart, dialogueFinish and dialogueCancel', async () => {
    const t = setup();
    const events: string[] = [];
    const log = <K extends keyof EasyTGEvents>(name: K, describe: (e: EasyTGEvents[K]) => string) =>
      t.app.on(name, (e) => void events.push(`${name}:${describe(e)}`));
    log('pageView', (e) => `${e.page}(${JSON.stringify(e.params)}) ${e.mode}`);
    log('dialogueStart', (e) => e.dialogue);
    log('dialogueFinish', (e) => `${e.dialogue} ${JSON.stringify(e.answers)}`);
    log('dialogueCancel', (e) => `${e.dialogue} ${e.reason}`);

    const survey = dialogue('survey').steps([{ id: 'q', type: 'text', text: 'Q?' }]).onFinish(() => ({ text: 'thanks' }));
    const other = dialogue('other').steps([{ id: 'q', type: 'text', text: 'Other?' }]).onFinish(() => undefined);
    const home = page('home').render(({ nav }) => ({ text: 'home', keyboard: [[nav.button('Detail', detail, { id: '1' })]] }));
    const detail = page<{ id: string }>('detail').render(() => ({ text: 'detail' }));
    t.app.register(home, detail, survey, other);
    t.bot.command('start', (ctx) => t.app.open(ctx, home));
    t.bot.command('survey', (ctx) => t.app.startDialogue(ctx, survey));
    t.bot.command('other', (ctx) => t.app.startDialogue(ctx, other));

    await t.message('/start');
    await t.press('p|detail|id=1');
    await t.message('/survey');
    await t.message('yes');
    await t.message('/survey');
    await t.message('/other'); // a command cancels, then another dialogue starts
    await t.press(t.find('sendMessage').at(-1)!.payload.reply_markup.inline_keyboard.at(-1)[0].callback_data);

    expect(events).toEqual([
      'pageView:home({}) send',
      'pageView:detail({"id":"1"}) edit',
      'dialogueStart:survey',
      'dialogueFinish:survey {"q":"yes"}',
      'dialogueStart:survey',
      'dialogueCancel:survey command',
      'dialogueStart:other',
      'dialogueCancel:other user',
    ]);
  });
});

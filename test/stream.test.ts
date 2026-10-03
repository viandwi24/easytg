import { describe, expect, test } from 'bun:test';
import { EasyTG, type EasyTGOptions } from '../src';
import { TelegramSimulator } from '../src/simulator';

function setup(options: EasyTGOptions = {}) {
  const sim = new TelegramSimulator();
  const bot = sim.createBot();
  const app = new EasyTG({ logger: false, ...options });
  bot.use(app);
  return { sim, bot, app };
}

async function* words(text: string, delayMs = 5) {
  for (const word of text.split(' ')) {
    await Bun.sleep(delayMs);
    yield `${word} `;
  }
}

describe('app.stream', () => {
  test('private chats: "Thinking…", a growing draft, then the formatted message', async () => {
    const { sim, bot, app } = setup();
    const drafts: string[] = [];
    sim.on('call', (c) => c.method === 'sendMessageDraft' && void drafts.push(c.payload.text));
    let result: unknown;
    bot.command('ask', async (ctx) => {
      result = await app.stream(ctx, words('The answer is **42**.'), { intervalMs: 0 });
    });
    await sim.send('/ask');
    expect(drafts[0]).toBe(''); // "Thinking…"
    expect(drafts.at(-1)).toBe('The answer is **42**. '); // previews are plain text
    expect(drafts).toEqual([...drafts].sort((a, b) => a.length - b.length)); // it only grows
    const last = sim.last()!.message;
    expect(last.text).toBe('The answer is 42.'); // the final message is formatted like a page
    expect(last.entities).toEqual([{ type: 'bold', offset: 14, length: 2 }]);
    expect(sim.chat(sim.user.id)!.draft).toBeNull();
    expect(result).toMatchObject({ text: 'The answer is **42**. ', stopped: false });
  });

  test('a stop button aborts the source; the text so far is the answer', async () => {
    const { sim, bot, app } = setup();
    let aborted = false;
    bot.command('ask', async (ctx) => {
      await app.stream(
        ctx,
        async function* (signal) {
          signal.addEventListener('abort', () => (aborted = true));
          for (let i = 1; !signal.aborted; i++) {
            await Bun.sleep(5);
            yield `${i} `;
          }
        },
        { stoppable: true, intervalMs: 0, finish: (text, { stopped }) => ({ text: stopped ? `${text}(stopped)` : text, parseMode: 'plain' }) },
      );
    });
    const asking = sim.send('/ask');
    for (let i = 0; i < 100 && !sim.chat(sim.user.id)?.draft?.text; i++) await Bun.sleep(5);
    expect(sim.chat(sim.user.id)!.draft).toMatchObject({ canStop: true });
    await sim.stopGeneration();
    await asking;
    expect(aborted).toBe(true);
    expect(sim.last()!.message.text).toMatch(/^1 (\d+ )*\(stopped\)$/);
  });

  test('groups: a message that grows by edits, then the final text in its place', async () => {
    const { sim, bot, app } = setup();
    const group = sim.createGroup({ title: 'G' });
    bot.command('ask', (ctx) => app.stream(ctx, words('one two three'), { intervalMs: 0 }).then(() => undefined));
    await sim.send('/ask', { chat: group.id });
    const methods = sim.calls.map((c) => c.method);
    expect(methods).not.toContain('sendMessageDraft'); // drafts are for private chats
    expect(methods.filter((m) => m === 'sendMessage')).toHaveLength(1); // the placeholder only
    const bot_ = sim.messages(group.id).filter((m) => m.fromBot);
    expect(bot_).toHaveLength(1);
    expect(bot_[0]!.message.text).toBe('one two three');
  });

  test('previews are spaced by intervalMs; the final message has everything', async () => {
    const { sim, bot, app } = setup();
    bot.command('ask', async (ctx) => void (await app.stream(ctx, words(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '), 2), { intervalMs: 50 })));
    await sim.send('/ask');
    const drafts = sim.calls.filter((c) => c.method === 'sendMessageDraft').length;
    expect(drafts).toBeLessThan(10); // ~80 ms of words, a preview per 50 ms
    expect(sim.last()!.message.text!.split(' ')).toHaveLength(40);
  });

  test('an error from the source is the caller’s', async () => {
    const { sim, bot, app } = setup();
    let caught: unknown;
    bot.command('ask', async (ctx) => {
      try {
        await app.stream(ctx, (async function* () {
          yield 'partial ';
          throw new Error('model down');
        })());
      } catch (error) {
        caught = error;
      }
    });
    await sim.send('/ask');
    expect((caught as Error).message).toBe('model down');
  });
});

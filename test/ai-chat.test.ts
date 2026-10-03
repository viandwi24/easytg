import { afterAll, expect, test } from 'bun:test';
import { messageText } from '../src/simulator';
import { loadBot } from '../src/simulator/load';

// The example runs with bot.start() (one update at a time): the stop button must still work.
const { sim, stop } = await loadBot(new URL('../examples/ai-chat.ts', import.meta.url));
afterAll(stop);

test('examples/ai-chat.ts: streams a draft, and stop works under bot.start()', async () => {
  await sim.send('What is streaming?');
  for (let i = 0; i < 200 && (sim.chat(sim.user.id)?.draft?.text.length ?? 0) < 40; i++) await Bun.sleep(10);
  const draft = sim.chat(sim.user.id)!.draft!;
  expect(draft.text).toStartWith('You asked: What is streaming?'); // a rich draft: shown formatted
  expect(draft.rich!.blocks[0]).toMatchObject({ type: 'paragraph', text: ['You asked: ', { type: 'bold', text: 'What is streaming?' }] });
  expect(draft.canStop).toBe(true);
  await sim.stopGeneration();
  for (let i = 0; i < 100 && !sim.last()!.fromBot; i++) await Bun.sleep(10);
  const answer = messageText(sim.last()!.message)!;
  expect(sim.last()!.message.rich_message).toBeDefined();
  expect(answer).toStartWith('You asked: What is streaming?');
  expect(answer).toEndWith('⏹ Stopped');
  expect(answer).not.toContain('Pressing stop keeps'); // cut short
});

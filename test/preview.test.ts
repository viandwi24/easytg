import { afterAll, describe, expect, test } from 'bun:test';
import { startPreview } from '../src/preview/server';
import { generateTest, screenOf } from '../src/preview/testgen';
import { TelegramSimulator } from '../src/simulator';

describe('easytg preview', () => {
  test('runs a bot file in its own process against the simulator, uploads included', async () => {
    const output: string[] = [];
    const preview = await startPreview(new URL('./fixtures/echo-bot.ts', import.meta.url).pathname, {
      open: false,
      watch: false,
      port: 4700 + Math.floor(Math.random() * 200),
      log: (line) => void output.push(line),
    });
    afterAll(() => preview.stop());
    const { sim } = preview;
    await sim.waitForPolling(10_000);
    await sim.send('hello');
    expect(sim.last()!.message.text).toBe('echo: hello');
    await sim.send('/start');
    await sim.tap('Photo');
    const shown = sim.last()!;
    expect(shown.media?.kind).toBe('photo');
    expect(shown.media?.url).toMatch(/^\/files\/\d+\/dot\.png$/);
    const served = await fetch(new URL(shown.media!.url!, preview.url));
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    const page = await (await fetch(preview.url)).text();
    expect(page).toContain('fixtures/echo-bot.ts');
    expect(page).not.toContain('%FILE%');
  }, 20_000);
});

test('generateTest writes a replayable bun test', () => {
  const sim = new TelegramSimulator();
  sim.addUser({ first_name: 'Alice' });
  const code = generateTest(sim, [{ code: 'await sim.send("/start")', chat: sim.user.id, screen: { text: 'Home', buttons: ['Go'] } }], './bot.ts');
  expect(code).toContain(`await loadBot("./bot.ts", { simulator: sim });`);
  expect(code).toContain('sim.addUser({"is_bot":false,"first_name":"Alice","id":1002});');
  expect(code).toContain('expect(screen()).toEqual({"text":"Home","buttons":["Go"]});');
  expect(screenOf(sim, sim.user.id)).toBeUndefined();
});

import { afterAll, describe, expect, test } from 'bun:test';
import { generateTest, screenOf, startStudio } from '@easytg/studio';
import { TelegramSimulator } from '@easytg/simulator';

describe('easytg studio', () => {
  test('runs a bot file in its own process against the simulator, uploads included', async () => {
    const output: string[] = [];
    const studio = await startStudio({
      file: new URL('./fixtures/echo-bot.ts', import.meta.url).pathname,
      watch: false,
      latencyMs: 0,
      port: 4700 + Math.floor(Math.random() * 200),
      log: (line) => void output.push(line),
    });
    afterAll(() => studio.stop());
    const { sim } = studio;
    await sim.waitForPolling(10_000);
    await sim.send('hello');
    expect(sim.last()!.message.text).toBe('echo: hello');
    await sim.send('/start');
    await sim.tap('Photo');
    const shown = sim.last()!;
    expect(shown.media?.kind).toBe('photo');
    expect(shown.media?.url).toMatch(/^\/files\/\d+\/dot\.png$/);
    const served = await fetch(new URL(shown.media!.url!, studio.url));
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    const page = await (await fetch(studio.url)).text();
    expect(page).toContain('fixtures/echo-bot.ts');
    expect(page).not.toContain('%TARGET%');
    // A wrong token is refused, like Telegram does.
    expect((await fetch(`${studio.url}/bot123:wrong/getMe`)).status).toBe(401);
  }, 20_000);
});

test('generateTest writes a replayable bun test', () => {
  const sim = new TelegramSimulator();
  sim.addUser({ first_name: 'Alice' });
  sim.createChannel({ title: 'News' });
  sim.createGroup({ title: 'Team', forum: true });
  const code = generateTest(sim, [{ code: 'await sim.send("/start")', chat: sim.user.id, screen: { text: 'Home', buttons: ['Go'] } }], './bot.ts');
  expect(code).toContain(`import { loadBot } from '@easytg/simulator/load';`);
  expect(code).toContain(`await loadBot("./bot.ts", { simulator: sim });`);
  expect(code).toContain('sim.addUser({"is_bot":false,"first_name":"Alice","id":1002});');
  expect(code).toContain('sim.createChannel({ id: -1000000000001, title: "News", owner: 1001, subscribers: [] });');
  expect(code).toContain('forum: true });');
  expect(code).toContain('expect(screen()).toEqual({"text":"Home","buttons":["Go"]});');
  expect(screenOf(sim, sim.user.id)).toBeUndefined();
});

/**
 * Runs in CI on Node.js (after `bun run build`): the built package loads, and
 * `loadBot` can run a bot file against the simulator. On Node, grammY calls
 * the real `node-fetch` package, which `interceptBotApi` has to replace.
 *
 *   node scripts/node-smoke.mjs
 */
import { loadBot } from '../dist/simulator/load.js';

const { sim, stop } = await loadBot(new URL('../test/fixtures/node-bot.mjs', import.meta.url));
await sim.send('/start');
const first = sim.last()?.message.text;
await sim.tap('Next');
const second = sim.last()?.message.text;
await stop();

if (first !== 'Hello from Node' || second !== 'Next page') {
  console.error('Node smoke test failed:', { first, second });
  process.exit(1);
}
console.log(`ok (${typeof Bun === 'undefined' ? `Node ${process.version}` : 'Bun'})`);

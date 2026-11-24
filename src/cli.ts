#!/usr/bin/env bun
/**
 * The easytg command line.
 *
 *   easytg preview <bot file> [options]   your bot in easytg studio (@easytg/studio)
 */
const HELP = `easytg preview <bot file> [options]

  Runs your bot file, unchanged, in easytg studio: a simulated Telegram in
  the browser, with profiles, chats, groups, the bot's output, every Bot API
  call, its flow map and "Export test". No token, no network: nothing
  reaches Telegram. The bot restarts when a file in its folder changes.

  It needs the studio:  bun add -d @easytg/studio
  (the same as: bunx easytg-studio <bot file> --open)

  --port <n>       the studio's port (default 4646)
  --users <n>      more profiles to switch between (Alice, Bob, …)
  --group          add a group with every profile
  --latency <ms>   delay every API call (default 120–280, like a real network)
  --no-open        don't open the browser
  --no-watch       don't restart on changes

  Needs Bun (https://bun.sh).`;

const args = process.argv.slice(2);
const command = args.shift();

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
function flag(name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) args.splice(index, 1);
  return index >= 0;
}

if (command !== 'preview' || flag('help') || flag('h')) {
  console.log(HELP);
  process.exit(command === 'preview' || command === undefined || command === '--help' ? 0 : 1);
}
if (typeof Bun === 'undefined') {
  console.error('easytg preview needs Bun: https://bun.sh (then: bunx easytg preview <file>)');
  process.exit(1);
}

const port = option('port');
const users = option('users');
const latency = option('latency');
const noOpen = flag('no-open');
const noWatch = flag('no-watch');
const group = flag('group');
const file = args[0];
if (!file) {
  console.log(HELP);
  process.exit(1);
}

type StudioModule = typeof import('@easytg/studio');
let studioModule: StudioModule;
try {
  studioModule = await import('@easytg/studio');
} catch {
  console.error('easytg preview runs easytg studio, which isn\'t installed here. Add it:\n\n  bun add -d @easytg/studio\n');
  process.exit(1);
}

const studio = await studioModule.startStudio({
  file,
  port: port ? Number(port) : undefined,
  users: users ? Number(users) : 0,
  group,
  latencyMs: latency ? Number(latency) : undefined,
  open: !noOpen,
  watch: !noWatch,
});
console.log(`\n  easytg studio: ${studio.url}\n  ${file} runs against a simulated Telegram. Ctrl+C to stop.\n`);

const shutdown = async () => {
  await studio.stop();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

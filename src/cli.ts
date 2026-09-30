#!/usr/bin/env bun
/**
 * The easytg command line.
 *
 *   easytg preview <bot file> [--port 4545] [--users 2] [--group] [--latency 300] [--no-open] [--no-watch]
 */
import { startPreview } from './preview/server';

const HELP = `easytg preview <bot file> [options]

  Runs your bot file, unchanged, against a simulated Telegram, and opens a
  chat window in the browser. No token, no network: nothing reaches Telegram.
  The bot restarts when a file in its folder changes; the chat stays.

  --port <n>       port of the chat window (default 4545)
  --users <n>      more users to switch between (Alice, Bob, …)
  --group          add a group with every user
  --latency <ms>   delay every API call, to see loading indicators
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

const preview = await startPreview(file, {
  port: port ? Number(port) : undefined,
  users: users ? Number(users) : 0,
  group,
  latencyMs: latency ? Number(latency) : undefined,
  open: !noOpen,
  watch: !noWatch,
});
console.log(`\n  easytg preview: ${preview.url}\n  ${file} runs against a simulated Telegram. Ctrl+C to stop.\n`);

const shutdown = async () => {
  await preview.stop();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

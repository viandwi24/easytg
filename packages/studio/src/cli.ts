#!/usr/bin/env bun
/**
 * easytg-studio: a Telegram for developing bots.
 *
 *   easytg-studio <bot file> [options]
 *   easytg-studio --cmd "<command>" [options]
 */
import { startStudio } from './server';

const HELP = `easytg-studio <bot file> [options]
easytg-studio --cmd "<command>" [options]

  A Telegram for development: your bot runs against a simulated Telegram,
  and the studio's page (at the URL it prints) shows profiles, chats and
  groups, the bot's output and every Bot API call. No token, no network: nothing
  reaches Telegram. The bot restarts when a file changes; the chats stay.

  <bot file>       a JavaScript/TypeScript bot, run unchanged with Bun
  --cmd "<cmd>"    any other bot (python bot.py, go run .): it gets
                   TELEGRAM_API_ROOT and BOT_TOKEN to connect with
  --port <n>       the studio's port (default 4646)
  --users <n>      more profiles to start with (Alice, Bob, …)
  --group          start with a group of every profile
  --latency <ms>   delay every Bot API call (default 120–280, like a
                   real network; 0 for none)
  --watch <dir>    the folder watched for changes
  --no-watch       don't restart on changes
  --open           open the studio in the browser

  Needs Bun (https://bun.sh).`;

const args = process.argv.slice(2);

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

if (flag('help') || flag('h')) {
  console.log(HELP);
  process.exit(0);
}
if (typeof Bun === 'undefined') {
  console.error('easytg-studio needs Bun: https://bun.sh');
  process.exit(1);
}

const command = option('cmd');
const port = option('port');
const users = option('users');
const latency = option('latency');
const watchDir = option('watch');
const open = flag('open');
const noWatch = flag('no-watch');
const group = flag('group');
const file = args[0];
if (!file && !command) {
  console.log(HELP);
  process.exit(1);
}

const studio = await startStudio({
  file: command ? undefined : file,
  command,
  port: port ? Number(port) : undefined,
  users: users ? Number(users) : undefined,
  latencyMs: latency ? Number(latency) : undefined,
  group,
  watchDir,
  open,
  watch: !noWatch,
});
console.log(`\n  easytg studio: ${studio.url}\n  ${command ?? file} runs against a simulated Telegram. Ctrl+C to stop.\n`);

const stop = async () => {
  await studio.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

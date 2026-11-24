import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { apiCoverage, botApiMethods, COVERAGE_PAGE, simulatorMethods } from '../scripts/api-coverage';

const root = join(import.meta.dir, '..');

/** The core library's sources: src/ without the simulator and preview re-exports. */
function coreFiles(dir = join(root, 'src')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ['simulator', 'preview'].includes(relative(join(root, 'src'), path)) ? [] : coreFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Bot API methods a source calls: `api.method(` (`ctx.api`, `bot.api`,
 * `api.raw`), grammY's `…Inline` variants, and context shortcuts
 * (`ctx.reply`, `ctx.replyWithPhoto`, `ctx.answerCallbackQuery`, …).
 */
function calledMethods(source: string, methods: Set<string>): Set<string> {
  const found = new Set<string>();
  const add = (name: string) => {
    const base = name.endsWith('Inline') ? name.slice(0, -'Inline'.length) : name;
    if (methods.has(base)) found.add(base);
  };
  for (const [, name] of source.matchAll(/\bapi\.(?:raw\.)?([a-zA-Z]+)\(/g)) add(name!);
  for (const [, name] of source.matchAll(/\bctx\.([a-zA-Z]+)\(/g)) {
    if (name === 'reply') add('sendMessage');
    else if (name!.startsWith('replyWith')) add(`send${name!.slice('replyWith'.length)}`);
    else add(name!);
  }
  return found;
}

describe('Bot API coverage', () => {
  test('docs/bot-api-coverage.md is up to date (bun run api-coverage)', () => {
    expect(readFileSync(COVERAGE_PAGE, 'utf8')).toBe(apiCoverage());
  });

  test('every Bot API method easytg calls is answered by the simulator', () => {
    const methods = new Set(botApiMethods());
    const supported = new Set(simulatorMethods());
    const missing: string[] = [];
    for (const file of coreFiles()) {
      for (const method of calledMethods(readFileSync(file, 'utf8'), methods)) {
        if (!supported.has(method)) missing.push(`${relative(root, file)}: ${method}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the scan finds calls', () => {
    const methods = new Set(botApiMethods());
    const found = calledMethods('ctx.api.sendPhoto(1); bot.api.editMessageTextInline(x); ctx.reply("a"); ctx.replyWithDocument(d); ctx.api.raw.stopPoll({})', methods);
    expect([...found].sort()).toEqual(['editMessageText', 'sendDocument', 'sendMessage', 'sendPhoto', 'stopPoll']);
  });
});

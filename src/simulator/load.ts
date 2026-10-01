/**
 * Run your bot's own file against a TelegramSimulator, unchanged: its calls
 * to api.telegram.org go to the simulator instead. For server runtimes (Bun,
 * Node); used by tests exported from `easytg preview` and by the preview
 * itself.
 *
 *   import { loadBot } from 'easytg/simulator/load';
 *
 *   const { sim, stop } = await loadBot('./src/bot.ts');
 *   await sim.send('/start');
 *   expect(sim.last()?.message.text).toContain('Welcome');
 *   await stop();
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Bot } from 'grammy';
import { TelegramSimulator, type SimulatorOptions } from './index';

const TELEGRAM = 'https://api.telegram.org';

type FetchLike = (input: string | URL | Request, init?: Record<string, any>) => Promise<Response>;

export interface InterceptOptions {
  /** Where to look for the `grammy` your bot uses. Default: the working directory. */
  from?: string;
}

/**
 * Send grammY's calls to api.telegram.org to `target` instead: a fetch
 * handler (in this process) or another Bot API root URL (`http://…`).
 * Covers bots created afterwards. Returns a function that undoes it.
 */
export function interceptBotApi(target: ((request: Request) => Promise<Response>) | string, options: InterceptOptions = {}): () => void {
  // grammY on Node and Bun calls `node-fetch` (read when a bot is created),
  // grammY for Deno and browsers the global fetch: replace both.
  const grammy = createRequire(join(resolve(options.from ?? process.cwd()), 'noop.js')).resolve('grammy');
  const nodeFetch = createRequire(grammy)('node-fetch') as { default: FetchLike };
  const previous = { node: nodeFetch.default, global: globalThis.fetch as unknown as FetchLike };

  const wrap =
    (original: FetchLike): FetchLike =>
    async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${TELEGRAM}/`)) return original(input, init);
      if (typeof target === 'string') return original(target.replace(/\/$/, '') + url.slice(TELEGRAM.length), init);
      return target(toRequest(url, init));
    };
  nodeFetch.default = wrap(previous.node);
  globalThis.fetch = wrap(previous.global) as typeof fetch;
  return () => {
    nodeFetch.default = previous.node;
    globalThis.fetch = previous.global as unknown as typeof fetch;
  };
}

/** A web Request from what grammY hands node-fetch (its signal and streams are Node's). */
function toRequest(url: string, init: Record<string, any> = {}): Request {
  const controller = new AbortController();
  const signal = init.signal as { aborted?: boolean; addEventListener?: (type: 'abort', fn: () => void) => void } | undefined;
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.('abort', () => controller.abort());
  let body = init.body as unknown;
  if (body && typeof body === 'object' && Symbol.asyncIterator in body && !(body instanceof ReadableStream)) body = streamOf(body as AsyncIterable<Uint8Array>);
  return new Request(url, { method: init.method ?? 'GET', headers: init.headers, body: body as BodyInit, signal: controller.signal, duplex: 'half' } as RequestInit);
}

/** A web stream of an async iterable (Node's streams are); `ReadableStream.from` needs Node 20.6. */
function streamOf(iterable: AsyncIterable<Uint8Array | string>): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * Remember every grammY `Bot` of that copy of grammY that gets used, so it
 * can be started or stopped from outside. Returns the list and an undo.
 */
export async function trackBots(options: InterceptOptions = {}): Promise<{ bots: Bot<any>[]; restore: () => void }> {
  const path = createRequire(join(resolve(options.from ?? process.cwd()), 'noop.js')).resolve('grammy');
  const { Bot } = (await import(pathToFileURL(path).href)) as typeof import('grammy');
  const bots: Bot<any>[] = [];
  const proto = Bot.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const patched = ['use', 'init', 'start'] as const;
  const originals = Object.fromEntries(patched.map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]));
  for (const name of patched) {
    const original = proto[name]!;
    proto[name] = function (this: Bot<any>, ...args: unknown[]) {
      if (!bots.includes(this)) bots.push(this);
      return original.apply(this, args);
    };
  }
  return {
    bots,
    restore: () => {
      for (const name of patched) {
        const descriptor = originals[name];
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete proto[name];
      }
    },
  };
}

export interface LoadBotOptions {
  /** Use this simulator (e.g. with more users). Default: a new one. */
  simulator?: TelegramSimulator;
  /** Options for the new simulator. */
  simulatorOptions?: SimulatorOptions;
  /** How long the file may take to start its bot. Default 5000 ms. */
  timeoutMs?: number;
}

export interface LoadedBot {
  sim: TelegramSimulator;
  /** The grammY bots the file created. */
  bots: Bot<any>[];
  /** Stop the bots and undo the interception. */
  stop(): Promise<void>;
}

/**
 * Import a bot's file with its Telegram calls going to a simulator. The file
 * runs as it is: `BOT_TOKEN` is set (to a fake token) if missing, and a bot
 * that doesn't call `bot.start()` itself (a webhook setup) is started. Load
 * a file once per process: modules run only once.
 */
export async function loadBot(file: string | URL, options: LoadBotOptions = {}): Promise<LoadedBot> {
  const path = file instanceof URL ? fileURLToPath(file) : resolve(file);
  const sim = options.simulator ?? new TelegramSimulator(options.simulatorOptions);
  const from = dirname(path);
  const restoreFetch = interceptBotApi((request) => sim.handleRequest(request), { from });
  const tracked = await trackBots({ from });
  process.env.BOT_TOKEN ??= sim.token;

  const timeoutMs = options.timeoutMs ?? 5000;
  let failure: unknown;
  // Not awaited: a file ending with `await bot.start()` only finishes when the bot stops.
  const loading = import(pathToFileURL(path).href).then(
    () => true,
    (error: unknown) => {
      failure = error;
      return true;
    },
  );
  const polling = sim.waitForPolling(timeoutMs).then(
    () => 'polling' as const,
    () => 'timeout' as const,
  );
  const first = await Promise.race([polling, loading.then(() => 'loaded' as const)]);
  const fail = (error: unknown) => {
    tracked.restore();
    restoreFetch();
    throw error;
  };
  if (failure) fail(failure);
  if (first === 'loaded') {
    // The file is done. If no bot polls soon, it only built the bot (a webhook setup): start it.
    await sim.waitForPolling(500).catch(() => {
      for (const bot of tracked.bots) if (!bot.isRunning()) bot.start().catch((error: unknown) => (failure ??= error));
    });
  }
  await sim.waitForPolling(timeoutMs).catch(fail);
  if (failure) fail(failure);

  return {
    sim,
    bots: tracked.bots,
    async stop() {
      await Promise.all(tracked.bots.filter((bot) => bot.isRunning()).map((bot) => bot.stop()));
      tracked.restore();
      restoreFetch();
    },
  };
}

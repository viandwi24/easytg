/**
 * Runs a bot's source code in the browser against a TelegramSimulator:
 * TypeScript is compiled with sucrase, `import`s of grammy and easytg are
 * served from this page, and `new Bot(...)` connects to the simulator. The
 * code stays the code you would run with Node or Bun.
 */
import * as grammy from 'grammy';
import { transform } from 'sucrase';
import * as easytg from 'easytg';
import * as testing from 'easytg/testing';
import { TelegramSimulator } from 'easytg/simulator/index';
import { id as localeId } from '../../../examples/locales/id';

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface RunOptions {
  /** Called for the bot's console output (and errors). */
  log(level: LogLevel, args: unknown[]): void;
  /** Add a group with a few members (for group examples). */
  group?: boolean;
  /** Add two more users, without a group. */
  users?: boolean;
  /** Answer floods with 429, like Telegram. */
  rateLimits?: boolean;
  latencyMs?: number;
}

export interface Run {
  sim: TelegramSimulator;
  /** Resolves once the bot is set up (or failed). */
  ready: Promise<void>;
  stop(): Promise<void>;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

export function compile(code: string): string {
  return transform(code, { transforms: ['typescript', 'imports'], production: true, disableESTransforms: true }).code;
}

export function runBot(code: string, options: RunOptions): Run {
  const sim = new TelegramSimulator({ latencyMs: options.latencyMs ?? 40, rateLimits: options.rateLimits });
  if (options.group || options.users) {
    sim.addUser({ first_name: 'Alice', language_code: 'en' });
    sim.addUser({ first_name: 'Bob', language_code: 'en' });
  }
  if (options.group) sim.createGroup({ title: 'Playground group', members: [...sim.users.keys()] });
  const bots: grammy.Bot<any>[] = [];
  const stops: (() => Promise<void>)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  class Bot<C extends grammy.Context = grammy.Context> extends grammy.Bot<C> {
    constructor(token: string, config: grammy.BotConfig<C> = {}) {
      super(token || sim.token, { ...config, botInfo: config.botInfo ?? sim.botInfo });
      if (bots.length) throw new Error('The playground runs one bot at a time');
      sim.connect(this);
      bots.push(this);
    }
  }

  class EasyTG<C extends grammy.Context = grammy.Context> extends easytg.EasyTG<C> {
    override startScheduler(...args: Parameters<easytg.EasyTG<C>['startScheduler']>) {
      const stop = super.startScheduler(...args);
      stops.push(stop);
      return stop;
    }
  }

  const modules: Record<string, unknown> = {
    grammy: { ...grammy, Bot },
    'grammy/types': {},
    'grammy/web': { ...grammy, Bot },
    easytg: { ...easytg, EasyTG },
    'easytg/testing': testing,
    './locales/id': { id: localeId },
  };
  const require = (name: string) => {
    const normalized = name.replace(/^\.\.\/src(\/index)?(\.ts)?$/, 'easytg').replace(/^\.\.\/src\/testing(\.ts)?$/, 'easytg/testing');
    if (normalized in modules) return modules[normalized];
    throw new Error(`The playground can import grammy and easytg, not "${name}"`);
  };

  const console = Object.fromEntries((['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => [level, (...args: unknown[]) => options.log(level === 'debug' ? 'log' : level, args)]));
  const process = {
    env: { BOT_TOKEN: sim.token, ADMIN_ID: String(sim.user.id), NODE_ENV: 'development' } as Record<string, string | undefined>,
    argv: [],
    pid: 1,
    on: () => process,
    once: () => process,
    exit: (code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    },
  };
  const Bun = {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => (timers.delete(timer), resolve()), ms);
        timers.add(timer);
      }),
  };

  // Handler errors are shown in the chat and the console, not thrown at the user.
  sim.on('error', ({ error }) => options.log('error', [error]));

  const ready = (async () => {
    const compiled = compile(code);
    const module = { exports: {} };
    const main = new AsyncFunction('require', 'exports', 'module', 'process', 'console', 'Bun', compiled);
    // Not awaited: `await bot.start()` only returns when the bot stops.
    const done = main(require, module.exports, module, process, console, Bun).catch((error: unknown) => {
      options.log('error', [error]);
      throw error;
    });
    done.catch(() => undefined); // reported above
    // Set up once the bot polls (bot.start), the code finished, or after a moment.
    for (let i = 0; i < 40; i++) {
      if (bots[0]?.isRunning()) return;
      const finished = await Promise.race([done.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 25))]);
      if (finished) return;
    }
  })();

  return {
    sim,
    ready,
    async stop() {
      timers.forEach(clearTimeout);
      await Promise.allSettled([
        ...stops.map((stop) => stop()),
        ...bots.filter((bot) => bot.isRunning()).map((bot) => Promise.race([bot.stop(), new Promise((resolve) => setTimeout(resolve, 1500))])),
      ]);
    },
  };
}

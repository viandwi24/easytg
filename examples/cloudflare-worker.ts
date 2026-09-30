/**
 * easytg on Cloudflare Workers (the same shape works on other edge and
 * serverless platforms): a webhook instead of polling, state in Redis over
 * HTTP, and scheduled tasks from a Cron Trigger. See docs/serverless.md.
 *
 *   wrangler.toml:  main = "cloudflare-worker.ts"
 *                   [triggers] crons = ["* * * * *"]
 *   secrets:        BOT_TOKEN, WEBHOOK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   then once:      curl "https://api.telegram.org/bot<token>/setWebhook?url=<worker url>&secret_token=<secret>"
 *
 * In your project, import from 'easytg' instead of '../src': Wrangler then
 * picks easytg's browser build (no Node APIs needed).
 */
import { Bot, webhookCallback } from 'grammy';
import { EasyTG, MemoryStorage, RedisStorage, md, page, task, type StorageAdapter } from '../src';

interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  /** Upstash (or any Redis with a REST API). Without it, state lives in memory: fine to try, lost between requests. */
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

/** Redis over HTTP: each command is a POST of `[command, ...args]`. */
function redisOverHttp(url: string, token: string): StorageAdapter {
  return new RedisStorage(async (command, args) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify([command, ...args]) });
    const { result, error } = (await response.json()) as { result?: unknown; error?: string };
    if (error) throw new Error(`Redis: ${error}`);
    return result;
  });
}

// ---- the bot: pages as usual ----

const remind = task<{ chatId: number }>('remind').run(async ({ payload, bot }) => {
  await bot.api.sendMessage(payload.chatId, '⏰ One minute is up!');
});

const home = page('home').render(({ ctx, nav }) => ({
  text: md`Hi **${ctx.from?.first_name ?? 'there'}**! This bot runs on the edge.`,
  keyboard: [[nav.button('🔢 Count', counter)], [nav.button('⏰ Remind me in a minute', reminder)]],
}));

// A session survives between requests only with a real storage (Redis here).
const counter = page('counter').render(({ session, nav }) => {
  const count = (session.get<number>('count') ?? 0) + 1;
  session.set('count', count);
  return { text: `Pressed ${count} time${count === 1 ? '' : 's'}.`, keyboard: [[nav.self('➕ Again')], [nav.back()]] };
});

// Tasks are saved in the storage and run by the Cron Trigger below.
const reminder = page('reminder').render(async ({ ctx, app, nav }) => {
  await app.schedule(remind, { chatId: ctx.chat!.id }, { delayMs: 60_000 });
  return { text: "OK, I'll remind you in about a minute.", keyboard: [[nav.back()]] };
});

// ---- one bot per isolate, created on the first request ----

let instance: { bot: Bot; app: EasyTG; handle: (request: Request) => Promise<Response> } | undefined;

function setup(env: Env) {
  if (instance) return instance;
  const storage = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? redisOverHttp(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN) : new MemoryStorage();
  const bot = new Bot(env.BOT_TOKEN);
  const app = new EasyTG({
    storage,
    // Requests run in several isolates at once: share rate limits, locks and queues through the storage.
    cluster: storage instanceof RedisStorage,
    // A webhook must be answered within seconds: wait less for a user's previous update.
    sequential: { timeoutMs: 5_000 },
  })
    .register(counter, reminder, remind)
    .command('start', home, { description: 'Main menu' });
  bot.use(app);
  const handle = webhookCallback(bot, 'cloudflare-mod', { secretToken: env.WEBHOOK_SECRET });
  instance = { bot, app, handle };
  return instance;
}

export default {
  /** Telegram's webhook requests. */
  fetch(request: Request, env: Env): Promise<Response> {
    return setup(env).handle(request);
  },
  /** The Cron Trigger: run the scheduled tasks that are due (there is no process to run them in between). */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const { bot, app } = setup(env);
    await app.runDueTasks(bot);
  },
};

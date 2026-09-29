/**
 * A production setup: shared storage, several processes, webhooks.
 *
 *   # one process, long polling, SQLite:
 *   BOT_TOKEN=123:abc bun run examples/production.ts
 *
 *   # several processes behind a load balancer, Redis, webhooks:
 *   BOT_TOKEN=123:abc REDIS_URL=redis://localhost:6379 WEBHOOK_URL=https://bot.example.com PORT=8080 \
 *   WEBHOOK_SECRET=some-random-string bun run examples/production.ts
 *
 * With `cluster: true`, rate limits, double-tap and busy checks, per-user
 * ordering and queues are shared through the storage, so a user flooding the
 * bot is stopped no matter which process gets their updates, and the same
 * user is never handled by two processes at once. Scheduled tasks can be
 * polled by every process: each task runs once.
 */
import { Database } from 'bun:sqlite';
import { RedisClient } from 'bun';
import { Bot, webhookCallback } from 'grammy';
import { EasyTG, RedisStorage, SqliteStorage, autoRetry, page, type StorageAdapter } from '../src';

const env = process.env;
if (!env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN. See the top of examples/production.ts.');
  process.exit(1);
}

// Redis when several processes (or machines) run the bot; SQLite for one machine.
let storage: StorageAdapter;
let closeStorage = () => {};
if (env.REDIS_URL) {
  const redis = new RedisClient(env.REDIS_URL);
  storage = new RedisStorage((command, args) => redis.send(command, args), { prefix: 'mybot:' });
  closeStorage = () => redis.close();
} else {
  storage = new SqliteStorage(new Database(env.DB_PATH ?? 'production.sqlite'));
}

const home = page('home').render(({ ctx, nav }) => ({
  text: [`Hello from process ${process.pid}!`, `Your id: ${ctx.from?.id}`],
  keyboard: [[nav.self('🔄 Refresh')]],
}));

const bot = new Bot(env.BOT_TOKEN);
const app = new EasyTG({
  storage,
  cluster: true, // rate limits, locks and queues shared through `storage`
  // Forge-proof buttons without a storage write per render.
  buttons: env.BUTTON_SECRET ? { params: 'signed', secret: env.BUTTON_SECRET } : {},
  session: { ttlMs: 90 * 24 * 60 * 60 * 1000 }, // forget users inactive for 90 days
  antiSpam: { limit: 15, windowMs: 10_000, cooldownMs: 60_000 },
  // Below grammY's 10 s webhook timeout; handlers must stay short too (the wait
  // plus the handler must answer in time, or Telegram sends the update again).
  sequential: { timeoutMs: 8_000 },
}).register(home);

app.on('error', ({ error, source }) => console.error(`[${source}]`, error)); // e.g. send to Sentry
app.on('spam', ({ userId, strike, silence }) => {
  console.warn(`user ${userId} is flooding (strike ${strike})`);
  if (strike >= 5) {
    void app.limitUser(userId, 24 * 60 * 60 * 1000); // mute for a day, in every process
    silence();
  }
});

bot.api.config.use(autoRetry()); // wait out "Too Many Requests" on every API call
bot.use(app);
bot.command('start', (ctx) => app.open(ctx, home));
bot.catch((err) => console.error('Bot error:', err.error));

const stopScheduler = app.startScheduler(bot);
const shutdown = async (stopUpdates: () => unknown) => {
  await stopUpdates();
  await stopScheduler();
  closeStorage();
  process.exit(0);
};

if (env.WEBHOOK_URL) {
  // Telegram delivers updates to every process behind the URL; handlers run concurrently.
  const server = Bun.serve({
    port: Number(env.PORT ?? 8080),
    fetch: webhookCallback(bot, 'bun', { secretToken: env.WEBHOOK_SECRET }),
  });
  await bot.api.setWebhook(env.WEBHOOK_URL, { secret_token: env.WEBHOOK_SECRET });
  console.log(`Webhook server on :${server.port} (process ${process.pid})`);
  process.once('SIGINT', () => shutdown(() => server.stop()));
  process.once('SIGTERM', () => shutdown(() => server.stop()));
} else {
  process.once('SIGINT', () => shutdown(() => bot.stop()));
  process.once('SIGTERM', () => shutdown(() => bot.stop()));
  await bot.start({ onStart: (me) => console.log(`@${me.username} is running (long polling). Send /start in Telegram.`) });
}

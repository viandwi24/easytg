# Serverless and edge

easytg runs where grammY runs: long polling on a server, webhooks on a
server, and serverless or edge platforms such as Cloudflare Workers, Deno
Deploy and Vercel. It has no Node-only dependencies, and bundlers for edge
platforms pick its browser build (the `workerd`, `worker` and `browser`
export conditions).

On a platform that runs your code per request, four things change:

| | why | what to do |
|---|---|---|
| **State** | nothing in memory survives between requests | a real [storage](storage.md): Redis over HTTP works everywhere (below) |
| **Several instances** | requests run in parallel isolates | `cluster: true`, so rate limits, locks and queues are shared through the storage |
| **No background work** | nothing runs between requests | run [scheduled tasks](scheduler.md) from the platform's cron: `app.runDueTasks(bot)` |
| **Time limits** | a webhook must be answered in seconds | keep handlers short; `sequential: { timeoutMs: 5_000 }` waits less for a user's previous update |

## Cloudflare Workers

[`examples/cloudflare-worker.ts`](../examples/cloudflare-worker.ts) is a
complete Worker: webhook, Redis over HTTP, a Cron Trigger for tasks.

```ts
import { Bot, webhookCallback } from 'grammy';
import { EasyTG, RedisStorage } from 'easytg';

let instance: ReturnType<typeof setup> | undefined;

function setup(env: Env) {
  const storage = new RedisStorage(async (command, args) => {
    const response = await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      body: JSON.stringify([command, ...args]),
    });
    const { result, error } = await response.json();
    if (error) throw new Error(error);
    return result;
  });
  const bot = new Bot(env.BOT_TOKEN);
  const app = new EasyTG({ storage, cluster: true, sequential: { timeoutMs: 5_000 } }).command('start', home);
  bot.use(app);
  return { bot, app, handle: webhookCallback(bot, 'cloudflare-mod', { secretToken: env.WEBHOOK_SECRET }) };
}

export default {
  fetch: (request: Request, env: Env) => (instance ??= setup(env)).handle(request),
  scheduled: async (_event: unknown, env: Env) => {
    const { bot, app } = (instance ??= setup(env));
    await app.runDueTasks(bot);
  },
};
```

- One bot per isolate, created on its first request: Workers get their
  settings (`env`) with the request.
- `RedisStorage` takes any function that runs a Redis command, so a REST
  API such as Upstash's works without a client library. It supports the
  atomic operations `cluster` needs.
- Add `crons = ["* * * * *"]` under `[triggers]` in `wrangler.toml` for the
  scheduled tasks, and set the webhook once:
  `https://api.telegram.org/bot<token>/setWebhook?url=<worker url>&secret_token=<secret>`.
- In the browser build, easytg can't follow async flows the way
  `AsyncLocalStorage` does; see [the simulator page](simulator.md#easytg-in-the-browser)
  for the one difference.

## Deno Deploy

```ts
import { Bot, webhookCallback } from 'npm:grammy';
import { EasyTG, RedisStorage } from 'npm:easytg';

const bot = new Bot(Deno.env.get('BOT_TOKEN')!);
const app = new EasyTG({ storage: new RedisStorage(/* Redis over HTTP, as above */), cluster: true });
bot.use(app);
Deno.serve(webhookCallback(bot, 'std/http'));
Deno.cron('easytg tasks', '* * * * *', () => app.runDueTasks(bot));
```

## Vercel, Netlify and other functions

Node functions work like a server with webhooks (`webhookCallback(bot,
'std/http')` or the adapter for your framework); edge functions like
Workers. Use a shared storage and `cluster: true` in both, and a cron job
that calls an endpoint running `app.runDueTasks(bot)`.

## Checking it locally

A Worker builds its bot on the first request, so there is nothing for
[`easytg preview`](preview.md) to start. Test it instead: `interceptBotApi`
sends the bot's calls to a simulator while the test calls the Worker's
`fetch` (with webhook requests) and `scheduled` handlers, as this
repository's `test/serverless.test.ts` does:

```ts
import { TelegramSimulator } from 'easytg/simulator';
import { interceptBotApi } from 'easytg/simulator/load';
import worker from './worker';

const sim = new TelegramSimulator();
const restore = interceptBotApi((request) => sim.handleRequest(request));
await worker.fetch(new Request('https://x/', { method: 'POST', body: JSON.stringify(update), headers }), env);
sim.last(chatId); // what the bot sent
```

A file that creates its bot at startup and only sets up a webhook does run
in `easytg preview`: it is started with polling there.

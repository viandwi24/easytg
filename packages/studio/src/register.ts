/**
 * Preloaded into a JavaScript/TypeScript bot's process by the studio
 * (`bun --preload`): its calls to api.telegram.org go to the studio instead,
 * and a bot that doesn't poll by itself (a webhook setup) is started, so
 * updates reach it.
 */
import { interceptBotApi, trackBots } from '@easytg/simulator/load';

const api = process.env.EASYTG_STUDIO_API;
const root = process.env.EASYTG_STUDIO_ROOT ?? process.cwd();

if (api) {
  try {
    interceptBotApi(api, { from: root });
  } catch {
    // Not a grammY bot: send the global fetch's Bot API calls to the studio.
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.telegram.org/')) return original(input, init);
      return original(api.replace(/\/$/, '') + url.slice('https://api.telegram.org'.length), init);
    }) as typeof fetch;
  }

  // Stop with the studio, even when it was killed without a chance to stop us.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 1000).unref();

  const { bots, started } = await trackBots({ from: root }).catch(() => ({ bots: [], started: new Set() }));
  setTimeout(() => {
    for (const bot of bots) {
      // Not "isn't running yet": on a slow network bot.start() can take longer than this.
      if (!started.has(bot) && !bot.isRunning()) {
        console.log('[studio] starting the bot (the file did not call bot.start())');
        bot.start().catch((error: unknown) => console.error('[studio]', error));
      }
    }
  }, 1500);
}

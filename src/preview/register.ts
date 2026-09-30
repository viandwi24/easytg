/**
 * Preloaded into the bot's process by `easytg preview`: its Bot API calls go
 * to the preview server, and a bot that doesn't poll by itself (a webhook
 * setup) is started, so updates reach it.
 */
import { interceptBotApi, trackBots } from '../simulator/load';

const api = process.env.EASYTG_PREVIEW_API;
const root = process.env.EASYTG_PREVIEW_ROOT ?? process.cwd();

if (api) {
  interceptBotApi(api, { from: root });
  const { bots } = await trackBots({ from: root });
  setTimeout(() => {
    for (const bot of bots) {
      if (!bot.isRunning()) {
        console.log('[easytg preview] starting the bot (the file did not call bot.start())');
        bot.start().catch((error: unknown) => console.error('[easytg preview]', error));
      }
    }
  }, 1500);
}

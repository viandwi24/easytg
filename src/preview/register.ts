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

  // Stop with the preview, even when it was killed without a chance to stop us.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 1000).unref();

  // The bot's flowchart, for the preview's Flow tab, whenever it changes.
  let lastChart = '';
  setInterval(() => {
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for('easytg.apps')] as Set<WeakRef<{ flowchart(): string }>> | undefined;
    const charts = [...(registry ?? [])].map((ref) => ref.deref()?.flowchart()).filter((chart): chart is string => !!chart);
    const chart = charts.join('\n\n');
    if (!chart || chart === lastChart) return;
    lastChart = chart;
    fetch(`${api}/_preview/flow`, { method: 'POST', body: chart }).catch(() => undefined);
  }, 1000).unref();

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

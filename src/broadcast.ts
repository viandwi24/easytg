import { isChatUnreachable, retryAfterMs } from './errors';
import { sentBeforeError } from './render';
import type { SendTarget } from './proactive';

export interface BroadcastProgress {
  total: number;
  sent: number;
  /** Users who blocked the bot or deleted their account. */
  blocked: number;
  failed: number;
}

export interface BroadcastResult extends BroadcastProgress {
  /** Chat ids that can't be reached anymore: remove them from your list. */
  blockedChats: number[];
  failures: Array<{ target: number | SendTarget; error: unknown }>;
  /** Stopped early through `signal`. */
  aborted: boolean;
}

export interface BroadcastSettings {
  /** Messages per second. Telegram allows about 30; default 25. */
  perSecond?: number;
  /**
   * Sends in flight at once. Each send waits for Telegram's answer, so one at
   * a time can't reach `perSecond` on a slow connection. Default 5.
   */
  concurrency?: number;
  /** Called after every recipient. */
  onProgress?: (progress: BroadcastProgress) => unknown;
  /** Abort to stop sending. */
  signal?: AbortSignal;
}

const MAX_RETRIES = 3;


export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send one item per target, paced, retrying rate limits. Used by `app.broadcast`. */
export async function runBroadcast(
  targets: Iterable<number | SendTarget>,
  send: (target: number | SendTarget) => Promise<unknown>,
  settings: BroadcastSettings,
): Promise<BroadcastResult> {
  const list = [...targets];
  const interval = 1000 / Math.max(1, settings.perSecond ?? 25);
  const result: BroadcastResult = { total: list.length, sent: 0, blocked: 0, failed: 0, blockedChats: [], failures: [], aborted: false };

  // Workers take the next target; starts are spaced by `interval` across all of them.
  let next = 0;
  let nextStart = Date.now();
  const worker = async () => {
    for (;;) {
      if (settings.signal?.aborted) {
        result.aborted = true;
        return;
      }
      const index = next++;
      if (index >= list.length) return;
      const slot = Math.max(nextStart, Date.now());
      nextStart = slot + interval;
      await sleep(slot - Date.now());
      if (settings.signal?.aborted) {
        result.aborted = true;
        return;
      }
      await sendOne(list[index]!);
      const { total, sent, blocked, failed } = result;
      await settings.onProgress?.({ total, sent, blocked, failed });
    }
  };

  const sendOne = async (target: number | SendTarget) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await send(target);
        result.sent++;
      } catch (error) {
        const wait = retryAfterMs(error);
        // Not when part of the page already went out: that part would arrive twice.
        if (wait !== undefined && attempt < MAX_RETRIES && !sentBeforeError(error)) {
          nextStart = Math.max(nextStart, Date.now() + wait); // the limit is per bot: every worker waits
          await sleep(wait);
          continue;
        }
        if (isChatUnreachable(error)) {
          result.blocked++;
          result.blockedChats.push(typeof target === 'number' ? target : target.chatId);
        } else {
          result.failed++;
          result.failures.push({ target, error });
        }
      }
      break;
    }
  };

  const workers = Math.max(1, Math.min(settings.concurrency ?? 5, list.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return result;
}

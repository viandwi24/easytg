import { isBlockedByUser as isUnreachable, retryAfter } from './errors';
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
  /** Stopped early through \`signal\`. */
  aborted: boolean;
}

export interface BroadcastSettings {
  /** Messages per second. Telegram allows about 30; default 25. */
  perSecond?: number;
  /** Called after every recipient. */
  onProgress?: (progress: BroadcastProgress) => unknown;
  /** Abort to stop sending. */
  signal?: AbortSignal;
}

const MAX_RETRIES = 3;


export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send one item per target, paced, retrying rate limits. Used by \`app.broadcast\`. */
export async function runBroadcast(
  targets: Iterable<number | SendTarget>,
  send: (target: number | SendTarget) => Promise<unknown>,
  settings: BroadcastSettings,
): Promise<BroadcastResult> {
  const list = [...targets];
  const interval = 1000 / Math.max(1, settings.perSecond ?? 25);
  const result: BroadcastResult = { total: list.length, sent: 0, blocked: 0, failed: 0, blockedChats: [], failures: [], aborted: false };

  for (const target of list) {
    if (settings.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        await send(target);
        result.sent++;
      } catch (error) {
        const wait = retryAfter(error);
        if (wait !== undefined && attempt < MAX_RETRIES) {
          await sleep(wait * 1000);
          continue;
        }
        if (isUnreachable(error)) {
          result.blocked++;
          result.blockedChats.push(typeof target === 'number' ? target : target.chatId);
        } else {
          result.failed++;
          result.failures.push({ target, error });
        }
      }
      break;
    }
    const { total, sent, blocked, failed } = result;
    await settings.onProgress?.({ total, sent, blocked, failed });
    await sleep(Math.max(0, interval - (Date.now() - started)));
  }
  return result;
}

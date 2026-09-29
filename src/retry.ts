import { HttpError, type Transformer } from 'grammy';

export interface AutoRetryOptions {
  /** Retries per API call. Default 3. */
  maxRetries?: number;
  /** Don't wait longer than this for one retry; the error is returned instead. Default 60 000. */
  maxDelayMs?: number;
  /**
   * Also retry network failures and Telegram server errors (5xx). Off by
   * default: the request may have gone through, so a retried send could
   * arrive twice.
   */
  retryUnsure?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An API transformer that waits out "Too Many Requests" (429) answers and
 * tries again, for every call the bot makes (pages, long messages split in
 * parts, notifications, broadcasts). Install it once:
 *
 *   bot.api.config.use(autoRetry());
 */
export function autoRetry(options: AutoRetryOptions = {}): Transformer {
  const maxRetries = options.maxRetries ?? 3;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  return async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt++) {
      let result: Awaited<ReturnType<typeof prev>>;
      try {
        result = await prev(method, payload, signal);
      } catch (error) {
        if (!options.retryUnsure || !(error instanceof HttpError) || attempt >= maxRetries || signal?.aborted) throw error;
        await sleep(Math.min(1000 * 2 ** attempt, maxDelayMs));
        continue;
      }
      if (result.ok || attempt >= maxRetries || signal?.aborted) return result;
      const retryAfter = result.error_code === 429 ? (result.parameters?.retry_after ?? 1) * 1000 : undefined;
      if (retryAfter !== undefined && retryAfter <= maxDelayMs) {
        await sleep(retryAfter);
        continue;
      }
      if (options.retryUnsure && result.error_code >= 500) {
        await sleep(Math.min(1000 * 2 ** attempt, maxDelayMs));
        continue;
      }
      return result;
    }
  };
}

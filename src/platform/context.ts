import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A value that follows an async flow (a handler and everything it awaits).
 * Server runtimes (Node, Bun, Deno) use AsyncLocalStorage; browser builds
 * swap this file for context.browser.ts.
 */
export class AsyncContext<T> {
  private readonly storage = new AsyncLocalStorage<T>();

  run<R>(value: T, fn: () => R): R {
    return this.storage.run(value, fn);
  }

  get(): T | undefined {
    return this.storage.getStore();
  }
}

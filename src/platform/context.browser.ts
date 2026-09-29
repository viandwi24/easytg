/**
 * Browsers have no AsyncLocalStorage (yet): the value is visible until the
 * first `await` of the flow. easytg uses it to recognise nested calls (a
 * `sendTo` from a handler of the same user, a queue job inside a queue job);
 * in browsers those fall back to the same-process checks, which is enough
 * for the simulator and playgrounds.
 */
export class AsyncContext<T> {
  private current: T | undefined;

  run<R>(value: T, fn: () => R): R {
    const previous = this.current;
    this.current = value;
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }

  get(): T | undefined {
    return this.current;
  }
}

// Named concurrency limits (`app.queue`, `app.enterQueue`).
import type { Context } from 'grammy';
import { Queue, type AtomicStorage, type QueueOptions, type Release } from '../coordination';
import type { EasyTG } from '../engine';
import { EasyTGError } from '../errors';
import type { Awaitable } from '../types';
import { flows } from './scope';

/** @internal */
export class Queues<C extends Context> {
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly app: EasyTG<C>,
    options: Record<string, QueueOptions>,
    /** Shared between processes with `cluster`. */
    shared: AtomicStorage | undefined,
  ) {
    for (const [name, queue] of Object.entries(options)) this.queues.set(name, new Queue(name, queue, shared));
  }

  async run<T>(name: string, job: () => Awaitable<T>, ctx?: C): Promise<T> {
    const flow = flows.get();
    // Called from inside a job (or an update) that holds a slot of this queue: don't wait for ourselves.
    if (flow?.queues.has(name)) return job();
    const release = await this.take(name, ctx);
    try {
      return await flows.run({ key: flow?.key, ctx: flow?.ctx, queues: new Set([...(flow?.queues ?? []), name]) }, job);
    } finally {
      await release();
    }
  }

  async enter(ctx: C, name: string): Promise<void> {
    const scope = this.app.scopes.get(ctx);
    if (!scope.inUpdate) throw new EasyTGError('enterQueue works while handling an update; use app.queue(name, job) elsewhere');
    const flow = flows.get();
    if (flow?.queues.has(name)) return; // this update holds a slot already
    (scope.held ??= []).push(await this.take(name, ctx));
    flow?.queues.add(name);
  }

  /** Release the slots `enter` took for this update. */
  async releaseHeld(ctx: C) {
    const scope = this.app.scopes.peek(ctx);
    if (!scope?.held) return;
    for (const release of scope.held.splice(0)) await release();
  }

  private take(name: string, ctx?: C): Promise<Release> {
    const queue = this.queues.get(name);
    if (!queue) throw new EasyTGError(`Queue "${name}" is not configured: add it to the \`queues\` option`);
    return queue.acquire(ctx?.from?.id, (position) => this.app.emit('queueWait', { ctx, queue: name, position }));
  }
}

import { randomUUID } from 'node:crypto';
import type { Task, TaskBot } from './define';
import { EasyTGError } from './errors';
import type { Logger } from './logger';
import type { StoredTask, TaskStore } from './storage';

export interface SchedulerOptions {
  /** Where tasks are kept. Default: `storage`, when it is a `TaskStore` (all built-in adapters are). */
  store?: TaskStore;
  /** How often due tasks are looked up, in ms. Default 1000. */
  pollMs?: number;
  /** Tasks started per poll. Default 20. */
  batchSize?: number;
  /** A running task is started again (elsewhere) if not finished within this many ms. Default 5 minutes. */
  leaseMs?: number;
  /** Runs before a failing task is dropped. Default 5. */
  maxAttempts?: number;
  /** Wait before retry number `attempt` (1, 2, …). Default: 10 s, 20 s, 40 s, … up to 1 hour. */
  retryDelayMs?: (attempt: number) => number;
}

/** When a task runs. */
export interface ScheduleOptions {
  /** Run after this many ms. */
  delayMs?: number;
  /** Run at this time (a Date or ms timestamp). Default: now. */
  at?: Date | number;
  /** Repeat every this many ms after the first run. */
  everyMs?: number;
  /** Your own id: scheduling again with the same id replaces the task. Default: random. */
  id?: string;
  /** Id of the bot to run it with (`ctx.me.id`), when the scheduler serves several bots. */
  botId?: number;
}

export interface TaskErrorEvent {
  error: unknown;
  task: { id: string; name: string; payload: unknown; attempts: number };
  /** False when the task was dropped (`maxAttempts` reached); recurring tasks still run next time. */
  willRetry: boolean;
}

type Handler = (args: { payload: any; bot: TaskBot; task: { id: string; attempts: number; dueAt: number } }) => Promise<void> | void;

const randomId = () => randomUUID();

/** Stores, claims and runs scheduled tasks. Internal: use the `EasyTG` methods. */
export class Scheduler {
  private readonly tasks = new Map<string, { run: Handler; options: Task['options'] }>();
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private bots: TaskBot[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running = new Set<Promise<unknown>>();
  private stopped = true;
  /** Tasks being executed by the poll loop. */
  private inFlight = 0;
  /** Bumped by every start(), so a poll of an earlier run never schedules another one. */
  private generation = 0;

  constructor(
    private readonly store: TaskStore | undefined,
    private readonly logger: Logger,
    private readonly onError: (event: TaskErrorEvent) => Promise<unknown>,
    options: SchedulerOptions,
  ) {
    this.pollMs = options.pollMs ?? 1000;
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => Math.min(10_000 * 2 ** (attempt - 1), 3_600_000));
  }

  define(name: string, run: Handler, options: Task['options'] = {}) {
    if (this.tasks.has(name)) throw new EasyTGError(`Task "${name}" is already registered`);
    this.tasks.set(name, { run, options });
  }

  has(name: string) {
    return this.tasks.has(name);
  }

  async schedule(name: string, payload: unknown, options: ScheduleOptions = {}): Promise<string> {
    if (!this.tasks.has(name)) throw new EasyTGError(`Task "${name}" is not registered`);
    const store = this.requireStore();
    const at = options.at instanceof Date ? options.at.getTime() : options.at;
    const runAt = Math.round(at ?? Date.now() + (options.delayMs ?? 0));
    if (!Number.isFinite(runAt)) throw new EasyTGError('Invalid schedule time');
    if (options.everyMs !== undefined && !(options.everyMs >= 1000)) throw new EasyTGError('`everyMs` must be at least 1000');
    const id = options.id ?? randomId();
    await store.saveTask({ id, name, payload: payload ?? null, runAt, dueAt: runAt, attempts: 0, everyMs: options.everyMs, bot: options.botId });
    return id;
  }

  cancel(id: string): Promise<boolean> {
    return this.requireStore().deleteTask(id);
  }

  start(bots: TaskBot[]): () => Promise<void> {
    this.requireStore();
    if (bots.length === 0) throw new EasyTGError('startScheduler needs at least one bot');
    if (!this.stopped) throw new EasyTGError('The scheduler is already running');
    this.bots = bots;
    this.stopped = false;
    const generation = ++this.generation;
    this.timer = setTimeout(() => this.track(this.poll(generation)), 0);
    return async () => {
      if (generation !== this.generation) return;
      this.stopped = true;
      clearTimeout(this.timer);
      await Promise.all(this.running);
    };
  }

  /** Claim and run due tasks once, and wait for them. Returns how many were claimed. */
  async runDue(bots?: TaskBot[], now = Date.now()): Promise<number> {
    if (bots?.length) this.bots = bots;
    const claimed = await this.claim(now, this.batchSize);
    await Promise.all(claimed.map((task) => this.track(this.execute(task, now))));
    return claimed.length;
  }

  private async claim(now: number, limit: number): Promise<StoredTask[]> {
    const store = this.requireStore();
    if (this.bots.length === 0) throw new EasyTGError('Running scheduled tasks needs a bot: runDueTasks(bot)');
    // Bot ids are needed to pick each task's bot (`botInfo` throws before init).
    await Promise.all(this.bots.map((bot) => (bot.isInited() ? undefined : bot.init())));
    return limit > 0 ? store.claimTasks(now, limit, this.leaseMs) : [];
  }

  /** Remember work in progress, so `stop()` can wait for it. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    void work.finally(() => this.running.delete(work)).catch(() => {});
    return work;
  }

  /**
   * Start due tasks without waiting for them, keeping at most `batchSize`
   * running, so one slow task doesn't hold up the others.
   */
  private async poll(generation: number) {
    const current = () => !this.stopped && generation === this.generation;
    if (!current()) return;
    let full = false;
    try {
      const now = Date.now();
      const free = this.batchSize - this.inFlight;
      const claimed = await this.claim(now, free);
      full = free > 0 && claimed.length === free;
      for (const task of claimed) {
        this.inFlight++;
        void this.track(this.execute(task, now)).finally(() => {
          this.inFlight--;
        });
      }
    } catch (error) {
      this.logger.error('Failed to poll scheduled tasks', error);
    }
    if (!current()) return;
    // A full batch: there may be more due right away.
    // Not unref'd: a process that only runs the scheduler must stay alive until stop().
    this.timer = setTimeout(() => this.track(this.poll(generation)), full ? 0 : this.pollMs);
  }

  private async execute(task: StoredTask, now: number) {
    const store = this.store!;
    const definition = this.tasks.get(task.name);
    const next = (attempts: number, runAt: number): StoredTask => ({ ...task, runAt, dueAt: runAt, attempts });
    const recur = () => {
      if (!task.everyMs) return undefined;
      let due = task.dueAt + task.everyMs;
      if (due <= now) due += Math.ceil((now - due + 1) / task.everyMs) * task.everyMs; // skip missed runs
      return next(0, due);
    };

    const bot = task.bot === undefined ? this.bots[0] : this.bots.find((b) => b.botInfo.id === task.bot);
    if (!definition || !bot) {
      // Registered by another app or version, or for a bot this process doesn't run:
      // leave it for a process that can run it.
      this.logger.warn(
        definition ? `Scheduled task "${task.name}" is for bot ${task.bot}, which this scheduler doesn't run` : `No handler for scheduled task "${task.name}"`,
      );
      // Soon again (not after a whole lease), for when that process claims it later.
      await store.finishTask(task, { ...task, runAt: now + Math.min(this.leaseMs, 30_000), attempts: task.attempts - 1 });
      return;
    }
    try {
      await definition.run({ payload: task.payload, bot, task: { id: task.id, attempts: task.attempts, dueAt: task.dueAt } });
    } catch (error) {
      const maxAttempts = definition.options.maxAttempts ?? this.maxAttempts;
      const willRetry = task.attempts < maxAttempts;
      const retry = willRetry
        ? { ...task, runAt: Date.now() + (definition.options.retryDelayMs ?? this.retryDelayMs)(task.attempts) }
        : recur();
      await this.onError({ error, task: { id: task.id, name: task.name, payload: task.payload, attempts: task.attempts }, willRetry });
      await store.finishTask(task, retry).catch((e) => this.logger.error('Failed to save a scheduled task', e));
      return;
    }
    // Done. If this write is lost, the task runs again after its lease (at least once, never lost).
    await store.finishTask(task, recur()).catch((e) => this.logger.error('Failed to mark a scheduled task as done', e));
  }

  private requireStore(): TaskStore {
    if (!this.store) {
      throw new EasyTGError('Scheduled tasks need a TaskStore: use MemoryStorage, SqliteStorage or RedisStorage, or pass scheduler.store');
    }
    return this.store;
  }
}

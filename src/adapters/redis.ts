import { toJson, type StorageAdapter, type StoredTask, type TaskStore } from '../storage';

/**
 * Runs one Redis command and returns its reply. Adapt your client:
 *
 *   // Bun:        const redis = new RedisClient(url);  (cmd, args) => redis.send(cmd, args)
 *   // ioredis:    (cmd, args) => redis.call(cmd, ...args)
 *   // node-redis: (cmd, args) => client.sendCommand([cmd, ...args])
 */
export type RedisCommand = (command: string, args: string[]) => Promise<unknown>;

export interface RedisStorageOptions {
  /** Prefix of every key (including the task queue), e.g. `'shopbot:'`. Default `easytg:`. */
  prefix?: string;
}

// Scripts run atomically on the server, so several processes can share one Redis.
// The TTL is set only when the key is created (a fixed window), never extended.
const INCREMENT = `
local existed = redis.call('EXISTS', KEYS[1])
local v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
if existed == 0 and tonumber(ARGV[2]) > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v`;

// KEYS: due-set, data-hash, attempts-hash. ARGV: now, limit, leaseMs.
const CLAIM = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local lease = tonumber(ARGV[1]) + tonumber(ARGV[3])
local out = {}
for _, id in ipairs(ids) do
  local data = redis.call('HGET', KEYS[2], id)
  if data then
    redis.call('ZADD', KEYS[1], lease, id)
    local attempts = redis.call('HINCRBY', KEYS[3], id, 1)
    table.insert(out, id)
    table.insert(out, data)
    table.insert(out, tostring(attempts))
  else
    redis.call('ZREM', KEYS[1], id)
  end
end
return out`;

// ARGV: id, claimed runAt, [next runAt, next data, next attempts, next id]
const FINISH = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) ~= tonumber(ARGV[2]) then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
if ARGV[3] then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[6])
  redis.call('HSET', KEYS[2], ARGV[6], ARGV[4])
  redis.call('HSET', KEYS[3], ARGV[6], ARGV[5])
end
return 1`;

const SAVE = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
return 1`;

const REMOVE = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
return removed`;

/**
 * Storage and task store on Redis (or Valkey, KeyDB, Dragonfly), for bots
 * running as several processes. No dependency: pass a function that runs a
 * command with the client you already use.
 *
 *   import { RedisClient } from 'bun';
 *   const redis = new RedisClient(process.env.REDIS_URL);
 *   const storage = new RedisStorage((cmd, args) => redis.send(cmd, args), { prefix: 'shopbot:' });
 */
export class RedisStorage implements StorageAdapter, TaskStore {
  private readonly prefix: string;

  constructor(
    private readonly command: RedisCommand,
    options: RedisStorageOptions = {},
  ) {
    this.prefix = options.prefix ?? 'easytg:';
  }

  async get(key: string): Promise<unknown> {
    const raw = await this.command('GET', [this.prefix + key]);
    return raw === null || raw === undefined ? null : JSON.parse(String(raw));
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    await this.command('SET', [this.prefix + key, toJson(value), ...px(ttlMs)]);
  }

  async delete(key: string): Promise<void> {
    await this.command('DEL', [this.prefix + key]);
  }

  async increment(key: string, by: number, ttlMs?: number): Promise<number> {
    const ms = ttlMs ? String(Math.max(1, Math.ceil(ttlMs))) : '0';
    return Number(await this.command('EVAL', [INCREMENT, '1', this.prefix + key, String(by), ms]));
  }

  async setIfAbsent(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const reply = await this.command('SET', [this.prefix + key, toJson(value), 'NX', ...px(ttlMs)]);
    return reply === 'OK';
  }

  async saveTask(task: StoredTask): Promise<void> {
    await this.command('EVAL', [SAVE, '3', ...this.taskKeys(), task.id, String(task.runAt), taskData(task), String(task.attempts)]);
  }

  async claimTasks(now: number, limit: number, leaseMs: number): Promise<StoredTask[]> {
    const reply = (await this.command('EVAL', [CLAIM, '3', ...this.taskKeys(), String(now), String(limit), String(leaseMs)])) as unknown[];
    const tasks: StoredTask[] = [];
    for (let i = 0; i + 2 < (reply?.length ?? 0); i += 3) {
      const data = JSON.parse(String(reply[i + 1])) as Pick<StoredTask, 'name' | 'payload' | 'dueAt' | 'everyMs' | 'bot'>;
      tasks.push({ id: String(reply[i]), ...data, runAt: now + leaseMs, attempts: Number(reply[i + 2]) });
    }
    return tasks;
  }

  async finishTask(claimed: StoredTask, next?: StoredTask): Promise<void> {
    const replacement = next ? [String(next.runAt), taskData(next), String(next.attempts), next.id] : [];
    await this.command('EVAL', [FINISH, '3', ...this.taskKeys(), claimed.id, String(claimed.runAt), ...replacement]);
  }

  async deleteTask(id: string): Promise<boolean> {
    return Number(await this.command('EVAL', [REMOVE, '3', ...this.taskKeys(), id])) > 0;
  }

  private taskKeys() {
    // One hash tag, so the three keys share a slot on Redis Cluster.
    const tag = `{${this.prefix}tasks}`;
    return [`${tag}:due`, `${tag}:data`, `${tag}:attempts`];
  }
}

function px(ttlMs?: number): string[] {
  return ttlMs ? ['PX', String(Math.max(1, Math.ceil(ttlMs)))] : [];
}

function taskData(task: StoredTask) {
  return JSON.stringify({ name: task.name, payload: task.payload ?? null, dueAt: task.dueAt, everyMs: task.everyMs, bot: task.bot });
}

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, RedisStorage, SqliteStorage, withPrefix, type StorageAdapter } from '../src';
import { verifyStorageAdapter, verifyTaskStore } from '../src/testing';

const dir = mkdtempSync(join(tmpdir(), 'easytg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('MemoryStorage', () => {
  test('passes the storage and task store checks', async () => {
    await verifyStorageAdapter(new MemoryStorage(), { ttlMs: 200 });
    await verifyTaskStore(new MemoryStorage());
  });

  test('withPrefix keeps the atomic operations', async () => {
    const inner = new MemoryStorage();
    const prefixed = withPrefix(inner, 'bot:');
    expect(await prefixed.increment!('n', 2)).toBe(2);
    expect(await prefixed.setIfAbsent!('lock', 1)).toBe(true);
    expect(await (inner as StorageAdapter).get('bot:n')).toBe(2);
    await verifyStorageAdapter(prefixed, { ttlMs: 200 });
  });
});

describe('SqliteStorage', () => {
  test('passes the storage and task store checks', async () => {
    const db = new Database(':memory:');
    await verifyStorageAdapter(new SqliteStorage(db), { ttlMs: 200 });
    await verifyTaskStore(new SqliteStorage(db, { table: 'other' }));
  });

  test('connections to one file share keys and never claim a task twice', async () => {
    const file = join(dir, 'shared.sqlite');
    const a = new SqliteStorage(new Database(file));
    const b = new SqliteStorage(new Database(file));
    await a.set('k', { v: 1 });
    expect(await b.get('k')).toEqual({ v: 1 });
    expect(await a.setIfAbsent('lock', 'a', 5000)).toBe(true);
    expect(await b.setIfAbsent('lock', 'b', 5000)).toBe(false);

    const now = Date.now();
    for (let i = 0; i < 20; i++) await a.saveTask({ id: `t${i}`, name: 'x', payload: i, runAt: now - i, dueAt: now - i, attempts: 0 });
    const [first, second] = await Promise.all([a.claimTasks(now, 15, 60_000), b.claimTasks(now, 15, 60_000)]);
    const ids = [...first, ...second].map((t) => t.id);
    expect(ids.length).toBe(20);
    expect(new Set(ids).size).toBe(20);
  });

  test('keeps working with databases written by the old example adapter', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE easytg_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
    db.prepare('INSERT INTO easytg_kv VALUES (?, ?, NULL)').run('session:1', JSON.stringify({ data: { a: 1 } }));
    expect(await new SqliteStorage(db).get('session:1')).toEqual({ data: { a: 1 } });
  });
});

// Needs a server: REDIS_URL=redis://localhost:6379 bun test test/storage.test.ts
describe.skipIf(!process.env.REDIS_URL)('RedisStorage (REDIS_URL)', () => {
  test('passes the storage and task store checks', async () => {
    const { RedisClient } = await import('bun');
    const redis = new RedisClient(process.env.REDIS_URL);
    const prefix = `easytg-test:${Date.now()}:`;
    try {
      await verifyStorageAdapter(new RedisStorage((cmd, args) => redis.send(cmd, args), { prefix }), { ttlMs: 200 });
      await verifyTaskStore(new RedisStorage((cmd, args) => redis.send(cmd, args), { prefix: `${prefix}tasks:` }));
    } finally {
      redis.close();
    }
  });
});

describe('RedisStorage', () => {
  test('sends plain commands with prefixed keys and JSON values', async () => {
    const calls: string[][] = [];
    const replies: Record<string, unknown> = { GET: '{"a":1}', SET: 'OK' };
    const storage = new RedisStorage(
      async (cmd, args) => {
        calls.push([cmd, ...args]);
        return replies[cmd] ?? null;
      },
      { prefix: 'p:' },
    );
    expect(await storage.get('k')).toEqual({ a: 1 });
    await storage.set('k', { b: 2 }, 1500);
    expect(await storage.setIfAbsent('lock', 'x', 2000)).toBe(true);
    await storage.delete('k');
    expect(calls).toEqual([
      ['GET', 'p:k'],
      ['SET', 'p:k', '{"b":2}', 'PX', '1500'],
      ['SET', 'p:lock', '"x"', 'NX', 'PX', '2000'],
      ['DEL', 'p:k'],
    ]);
  });
});

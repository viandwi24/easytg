import { describe, expect, test } from 'bun:test';
import * as node from 'node:crypto';
import { fromBase64Url, hmacSha256, sha256, timingSafeEqual, toBase64Url, toHex, utf8 } from '../src/platform/crypto';

const samples = ['', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(200), 'héllo wörld 🎉', 'p|order|id=42&page=3'];

describe('platform crypto matches node:crypto', () => {
  test('sha256', () => {
    for (const s of samples) expect(toHex(sha256(s))).toBe(node.createHash('sha256').update(s).digest('hex'));
  });

  test('hmac-sha256 (short and long keys)', () => {
    for (const key of ['', 'secret', 'k'.repeat(64), 'k'.repeat(100), 'WebAppData']) {
      for (const s of samples) expect(toHex(hmacSha256(key, s))).toBe(node.createHmac('sha256', key).update(s).digest('hex'));
    }
    const secret = node.createHmac('sha256', 'WebAppData').update('1:TOKEN').digest();
    expect(toHex(hmacSha256(hmacSha256('WebAppData', '1:TOKEN'), 'a=1\nb=2'))).toBe(node.createHmac('sha256', secret).update('a=1\nb=2').digest('hex'));
  });

  test('base64url', () => {
    for (const s of samples) {
      const bytes = utf8(s);
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
      expect(Buffer.from(fromBase64Url(toBase64Url(bytes))).toString('utf8')).toBe(s);
    }
    expect(Buffer.from(fromBase64Url('aGk=')).toString()).toBe('hi'); // padded, standard base64
  });

  test('timingSafeEqual', () => {
    expect(timingSafeEqual(utf8('abc'), utf8('abc'))).toBe(true);
    expect(timingSafeEqual(utf8('abc'), utf8('abd'))).toBe(false);
    expect(timingSafeEqual(utf8('abc'), utf8('ab'))).toBe(false);
  });
});

describe('async context', () => {
  test('server runtimes follow the value across awaits', async () => {
    const { AsyncContext } = await import('../src/platform/context');
    const context = new AsyncContext<number>();
    const seen = await context.run(1, async () => {
      await Bun.sleep(1);
      return context.get();
    });
    expect(seen).toBe(1);
    expect(context.get()).toBeUndefined();
  });

  test('the browser fallback sees the value until the first await, and restores the previous one', async () => {
    const { AsyncContext } = await import('../src/platform/context.browser');
    const context = new AsyncContext<number>();
    const inner = context.run(1, () => context.run(2, () => context.get()));
    expect(inner).toBe(2);
    expect(context.get()).toBeUndefined();
    expect(() => context.run(3, () => {
      throw new Error('x');
    })).toThrow('x');
    expect(context.get()).toBeUndefined();
  });
});

test('the browser build has no Node-only imports', async () => {
  const result = await Bun.build({
    entrypoints: ['./src/index.ts', './src/simulator/index.ts'],
    target: 'browser',
    packages: 'external',
    plugins: [
      {
        name: 'browser-platform',
        setup(build) {
          build.onResolve({ filter: /\/platform\/context$/ }, () => ({ path: new URL('../src/platform/context.browser.ts', import.meta.url).pathname }));
        },
      },
    ],
  });
  expect(result.success).toBe(true);
  for (const output of result.outputs) {
    const code = await output.text();
    expect(code).not.toMatch(/["']node:|AsyncLocalStorage|\bBuffer\./);
  }
});

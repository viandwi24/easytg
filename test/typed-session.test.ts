import { expect, test } from 'bun:test';
import type { Session } from '../src';

declare module '../src' {
  interface SessionData {
    typedCounter: number;
  }
}

test('SessionData types declared keys; other keys stay open', () => {
  const check = (session: Session) => {
    const n: number | undefined = session.get('typedCounter');
    session.set('typedCounter', 2);
    // @ts-expect-error wrong type for a declared key
    session.set('typedCounter', 'x');
    const other = session.get<string>('free');
    session.set('free', { any: 1 });
    return [n, other];
  };
  expect(typeof check).toBe('function');
});

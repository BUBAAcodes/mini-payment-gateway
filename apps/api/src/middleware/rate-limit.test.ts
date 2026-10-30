import { describe, expect, it } from 'vitest';
import { createMemoryStore, fixedWindow } from './rate-limit';

const MINUTE = 60_000;

describe('fixedWindow', () => {
  it('numbers each minute and counts the seconds left in it, rounded up', () => {
    const start = 29_000_000 * MINUTE;
    expect(fixedWindow(start, MINUTE)).toEqual({ id: 29_000_000, secondsLeft: 60 });
    expect(fixedWindow(start + 1, MINUTE)).toEqual({ id: 29_000_000, secondsLeft: 60 });
    expect(fixedWindow(start + 59_500, MINUTE)).toEqual({ id: 29_000_000, secondsLeft: 1 });
    expect(fixedWindow(start + MINUTE, MINUTE)).toEqual({ id: 29_000_001, secondsLeft: 60 });
  });
});

describe('createMemoryStore', () => {
  it('counts hits per key', async () => {
    const store = createMemoryStore();
    expect(await store.hit('a', 60)).toBe(1);
    expect(await store.hit('a', 60)).toBe(2);
    expect(await store.hit('b', 60)).toBe(1);
  });

  it('forgets a key once its time to live is up, like EXPIRE', async () => {
    let now = 0;
    const store = createMemoryStore(() => now);
    await store.hit('a', 60);
    now = 59_999;
    expect(await store.hit('a', 60)).toBe(2);
    now = 60_000;
    expect(await store.hit('a', 60)).toBe(1);
  });
});

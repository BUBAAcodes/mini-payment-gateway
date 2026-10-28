import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isId, newId, randomBase62 } from './ids';

describe('newId', () => {
  it('is the prefix, an underscore and 14 base62 characters', () => {
    expect(newId('pay')).toMatch(/^pay_[0-9A-Za-z]{14}$/);
  });

  it('works for every prefix', () => {
    for (const prefix of Object.values(ID_PREFIXES)) {
      expect(isId(prefix, newId(prefix))).toBe(true);
    }
  });

  it('does not repeat across 10,000 IDs', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('order')));
    expect(ids.size).toBe(10_000);
  });
});

describe('isId', () => {
  it('rejects the wrong prefix, length or alphabet', () => {
    expect(isId('pay', newId('order'))).toBe(false);
    expect(isId('pay', 'pay_abc')).toBe(false);
    expect(isId('pay', 'pay_abcdefghijklm-')).toBe(false);
  });
});

describe('randomBase62', () => {
  it('returns the requested length using only base62 characters', () => {
    expect(randomBase62(32)).toMatch(/^[0-9A-Za-z]{32}$/);
  });

  it('rejects a non-positive length', () => {
    expect(() => randomBase62(0)).toThrow();
  });
});

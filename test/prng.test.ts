import { describe, expect, it } from 'vitest';
import { hashString, Rng } from '../src/prng.js';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect(Array.from({ length: 20 }, () => a.float())).toEqual(Array.from({ length: 20 }, () => b.float()));
  });

  it('differs across seeds', () => {
    expect(new Rng(1).float()).not.toEqual(new Rng(2).float());
  });

  it('int() stays within inclusive bounds and covers them', () => {
    const r = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const n = r.int(3, 6);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('chance(0) is never true', () => {
    const r = new Rng(9);
    for (let i = 0; i < 1000; i++) expect(r.chance(0)).toBe(false);
  });

  it('hashString is stable', () => {
    expect(hashString('hookstorm')).toBe(hashString('hookstorm'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});

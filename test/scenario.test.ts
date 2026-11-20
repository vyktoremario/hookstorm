import { describe, expect, it } from 'vitest';
import { PROFILES, resolveProfile } from '../src/profiles.js';
import { buildPlan, describeFaults } from '../src/scenario.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);
const plan = (seed: number, opts: Partial<Parameters<typeof buildPlan>[0]> = {}) =>
  buildPlan({
    eventIds: ids(20),
    profile: PROFILES.realistic,
    profileName: 'realistic',
    seed,
    maxAttempts: 5,
    ...opts,
  });

describe('buildPlan', () => {
  it('is a pure function of its inputs (same seed → same plan)', () => {
    expect(plan(123)).toEqual(plan(123));
  });

  it('produces different plans for different seeds', () => {
    expect(plan(1)).not.toEqual(plan(2));
  });

  it('delivers every event at least once', () => {
    for (let seed = 1; seed < 50; seed++) {
      const p = plan(seed);
      expect(new Set(p.deliveries.map((d) => d.eventId))).toEqual(new Set(ids(20)));
      expect([...p.order].sort()).toEqual([...ids(20)].sort());
    }
  });

  it('keeps the final attempt clean when retries exist', () => {
    for (let seed = 1; seed < 50; seed++)
      for (const d of plan(seed).deliveries) {
        expect(d.faults).toHaveLength(5);
        expect(d.faults[4]!.kind).toBe('none');
      }
  });

  it('allows a single attempt to fail when the provider never retries (GitHub)', () => {
    const faults = Array.from({ length: 50 }, (_, s) => plan(s + 1, { maxAttempts: 1 }))
      .flatMap((p) => p.deliveries)
      .map((d) => d.faults[0]!.kind);
    expect(faults).toContain('dropRequest');
  });

  it('bounds reordering by the window', () => {
    const p = plan(5, { eventIds: ids(200), profile: { ...PROFILES.realistic, reorderWindow: 3 } });
    // An event can jump ahead of at most window-1 earlier events. (Chained swaps can carry one event further
    // back, which is how late events behave in practice.)
    p.order.forEach((id, pos) => expect(Number(id.slice(1)) - pos).toBeLessThanOrEqual(2));
    expect(p.order).not.toEqual(ids(200));
  });

  it('does not reorder with window 0', () => {
    const p = plan(5, { profile: { ...PROFILES.realistic, reorderWindow: 0 } });
    expect(p.order).toEqual(ids(20));
  });

  it('fires concurrent duplicates at the same moment as the original', () => {
    const p = plan(3, { eventIds: ids(200), profile: PROFILES.hostile });
    const byId = new Map(p.deliveries.map((d) => [d.deliveryId, d]));
    const concurrent = p.deliveries.filter((d) => d.concurrentWith);
    expect(concurrent.length).toBeGreaterThan(0);
    for (const c of concurrent) {
      const o = byId.get(c.concurrentWith!)!;
      expect(c.startAtMs + c.delayMs).toBe(o.startAtMs + o.delayMs);
    }
  });

  it('roughly respects profile probabilities', () => {
    const p = plan(11, { eventIds: ids(2000), maxAttempts: 2 });
    const f = describeFaults(p);
    const firstAttempts = p.deliveries.length;
    expect(f.duplicates! / 2000).toBeGreaterThan(0.2);
    expect(f.duplicates! / 2000).toBeLessThan(0.3);
    expect(f.dropResponse! / firstAttempts).toBeGreaterThan(0.12);
    expect(f.dropResponse! / firstAttempts).toBeLessThan(0.18);
  });

  it('rejects maxAttempts < 1', () => {
    expect(() => plan(1, { maxAttempts: 0 })).toThrow();
  });
});

describe('resolveProfile', () => {
  it('defaults to realistic', () => expect(resolveProfile(undefined).name).toBe('realistic'));
  it('merges overrides onto a base profile', () => {
    const { profile, name } = resolveProfile({ extends: 'gentle', duplicate: 0.9 });
    expect(name).toBe('gentle+custom');
    expect(profile.duplicate).toBe(0.9);
    expect(profile.dropRequest).toBe(PROFILES.gentle.dropRequest);
  });
  it('rejects unknown names and impossible probabilities', () => {
    expect(() => resolveProfile('nope' as never)).toThrow(/Unknown profile/);
    expect(() => resolveProfile({ dropRequest: 0.6, dropResponse: 0.6 })).toThrow();
  });
});

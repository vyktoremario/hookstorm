import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, type HookstormConfig } from '../src/config.js';
import { custom } from '../src/invariants.js';
import { runSuite, seedsFor, NO_EFFECT_WARNING } from '../src/runner.js';
import { toJunit } from '../src/report.js';
import { fakeReceiver, freePort } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function suite(patch: Partial<HookstormConfig>, status = 200) {
  const rx = await fakeReceiver(() => ({ status }));
  close = rx.close;
  const cfg = await resolveConfig({
    target: rx.url,
    provider: 'paystack',
    secret: 'sk_test',
    events: [{ id: 'e1', body: { event: 'charge.success', data: { reference: 'r1' } } }],
    profile: { extends: 'gentle', dropRequest: 0, dropResponse: 0, duplicate: 0, delay: 0 },
    settleMs: 0,
    sink: { port: await freePort() },
    invariants: [custom('always holds', () => [])],
    ...patch,
  });
  return runSuite(cfg, [1, 2]);
}

describe('run warnings', () => {
  it('warns and is inconclusive when the probe state never changes and nothing hit the sink', async () => {
    const s = await suite({ probe: () => ({ orders: [] }) });
    expect(s.runs.every((r) => r.warnings.includes(NO_EFFECT_WARNING))).toBe(true);
    expect(s.inconclusive).toBe(true);
    expect(s.passed).toBe(false);
    expect(toJunit(s)).toContain('name="events had a visible effect"><failure');
  });

  it('does not warn when the probe state changes', async () => {
    let n = 0;
    const s = await suite({ probe: () => ({ calls: n++ }) });
    expect(s.runs.flatMap((r) => r.warnings)).toEqual([]);
    expect(s.inconclusive).toBe(false);
    expect(s.passed).toBe(true);
  });

  it('warns when nothing is observable at all (no probe, no sink calls)', async () => {
    const s = await suite({});
    expect(s.runs[0]!.warnings[0]).toMatch(/nothing was observed/);
    expect(s.inconclusive).toBe(true);
  });

  it('warns when no delivery is acknowledged, naming the status', async () => {
    const s = await suite({ probe: () => ({}) }, 401);
    expect(s.runs[0]!.warnings).toHaveLength(1);
    expect(s.runs[0]!.warnings[0]).toMatch(/no delivery was acknowledged \(the app answered 401\)/);
  });
});

describe('seedsFor', () => {
  it('runs consecutive seeds, each repeated in a row', () => {
    expect(seedsFor(5, 3)).toEqual([5, 6, 7]);
    expect(seedsFor(5, 2, 3)).toEqual([5, 5, 5, 6, 6, 6]);
    expect(seedsFor(5, 0, 0)).toEqual([5]);
  });
});

describe('runSuite with repeated seeds', () => {
  it('numbers the repeats of each seed and records the repeat count', async () => {
    const rx = await fakeReceiver();
    close = rx.close;
    let n = 0;
    const cfg = await resolveConfig({
      target: rx.url,
      provider: 'paystack',
      secret: 'sk_test',
      events: [{ id: 'e1', body: { event: 'charge.success', data: { reference: 'r1' } } }],
      settleMs: 0,
      sink: { port: await freePort() },
      probe: () => ({ n: n++ }),
      invariants: [custom('holds', () => [])],
    });
    const s = await runSuite(cfg, seedsFor(9, 2, 2));
    expect(s.runs.map((r) => [r.seed, r.repeat])).toEqual([
      [9, 1],
      [9, 2],
      [10, 1],
      [10, 2],
    ]);
    expect(s.repeat).toBe(2);
    // invariants can compare the state right after reset with the state after the run
    expect(s.runs.every((r) => r.state !== undefined)).toBe(true);
    // Same seed, same plan: only the app's timing can differ between repeats.
    expect(s.runs[0]!.plan).toEqual(s.runs[1]!.plan);
  });
});

describe('observations.baseline', () => {
  it('is the probe snapshot taken right after reset, before any delivery', async () => {
    let n = 0;
    const seen: Array<[unknown, unknown]> = [];
    const rx = await fakeReceiver();
    close = rx.close;
    const cfg = await resolveConfig({
      target: rx.url,
      provider: 'paystack',
      secret: 'sk_test',
      events: [{ id: 'e1', body: { event: 'charge.success', data: { reference: 'r1' } } }],
      settleMs: 0,
      sink: { port: await freePort() },
      probe: () => ({ read: n++ }),
      invariants: [custom('capture', ({ baseline, state }) => void seen.push([baseline, state]))],
    });
    await runSuite(cfg, [1]);
    expect(seen).toEqual([[{ read: 0 }, { read: 1 }]]);
  });
});

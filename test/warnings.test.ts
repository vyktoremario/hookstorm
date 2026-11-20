import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, type HookstormConfig } from '../src/config.js';
import { custom } from '../src/invariants.js';
import { runSuite, NO_EFFECT_WARNING } from '../src/runner.js';
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

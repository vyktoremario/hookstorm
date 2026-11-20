import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfigFile, resolveConfig } from '../src/config.js';
import { runSuite, seedsFor } from '../src/runner.js';
import { freePort, startExample } from './helpers.js';

// Hookstorm's own regression suite, and proof the README demo works: the buggy receiver must break every
// invariant it is designed to break, and the fixed receiver must hold all of them across many seeds.
const CONFIG = resolve('examples/hookstorm.config.ts');
const procs: ChildProcess[] = [];
afterAll(() => procs.forEach((p) => p.kill()));

async function suiteAgainst(which: 'buggy' | 'fixed', seeds: number[]) {
  const sinkPort = await freePort();
  const { port, proc } = await startExample(which, sinkPort);
  procs.push(proc);
  const cfg = await resolveConfig(await loadConfigFile(CONFIG), CONFIG, {
    target: `http://127.0.0.1:${port}/webhooks/paystack`,
    sinkPort,
  });
  return runSuite(cfg, seeds);
}

describe('demo receivers', () => {
  it('buggy receiver violates all five invariants', async () => {
    const suite = await suiteAgainst('buggy', seedsFor(1, 5));
    expect(suite.passed).toBe(false);
    expect(suite.runs.every((r) => !r.fatal)).toBe(true);
    expect([...suite.failedInvariants].sort()).toEqual(
      [
        'a refunded payment stays refunded',
        'each payment is credited to the wallet at most once',
        'each payment sends at most one receipt',
        'every acknowledged refund is debited exactly once',
        'wallet balances match acknowledged payments and refunds',
      ].sort(),
    );
  });

  it('fixed receiver holds every invariant across 50 seeds', { timeout: 180_000 }, async () => {
    const suite = await suiteAgainst('fixed', seedsFor(1000, 50));
    const failures = suite.runs
      .filter((r) => r.violations.length)
      .map((r) => ({ seed: r.seed, v: r.violations }));
    expect(failures).toEqual([]);
    expect(suite.passed).toBe(true);
  });
});

import { type ChildProcess, spawn } from 'node:child_process';
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
    expect(suite.inconclusive).toBe(false);
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
    expect(suite.runs.flatMap((r) => r.warnings)).toEqual([]);
    expect(suite.passed).toBe(true);
  });
});

describe('probe-only example (custom provider, no sink)', () => {
  const PROBE_CONFIG = resolve('examples/probe-only.config.ts');

  async function run(idempotent: boolean) {
    const port = await freePort();
    const proc = spawn(process.execPath, ['examples/probe-only-receiver/server.mjs'], {
      env: { ...process.env, PORT: String(port), IDEMPOTENT: idempotent ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    procs.push(proc);
    await new Promise<void>((r) =>
      proc.stdout!.on('data', (d: Buffer) => d.toString().includes('listening') && r()),
    );
    const cfg = await resolveConfig(await loadConfigFile(PROBE_CONFIG), PROBE_CONFIG, {
      target: `http://127.0.0.1:${port}/webhooks`,
      sinkPort: await freePort(),
    });
    return runSuite(cfg, seedsFor(1, 10));
  }

  it('finds duplicate ledger entries in the non-idempotent receiver', async () => {
    const suite = await run(false);
    expect(suite.failedInvariants).toEqual(['one ledger entry per payment']);
  });

  it('passes once the receiver is idempotent', async () => {
    const suite = await run(true);
    expect(suite.runs.flatMap((r) => r.violations)).toEqual([]);
  });
});

import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { ResolvedConfig } from './config.js';
import { buildPlan } from './scenario.js';
import { executePlan, sleep } from './simulator.js';
import { SinkServer } from './sink.js';
import type {
  DeliveryPlan,
  DeliveryRecord,
  Observations,
  SinkCall,
  Violation,
  WebhookEvent,
} from './types.js';

export interface RunResult {
  seed: number;
  plan: DeliveryPlan;
  deliveries: DeliveryRecord[];
  sink: SinkCall[];
  state: unknown;
  violations: Violation[];
  durationMs: number;
  /** Set when the target could not be reached at all. */
  fatal?: string;
  /** Things that make this run's result untrustworthy, e.g. the events had no visible effect. */
  warnings: string[];
  /** 1-based index of this run among the runs of the same seed (`--repeat-seed`). */
  repeat: number;
}

/** A warning raised when nothing the app did could be observed, so passing rules prove nothing. */
export const NO_EFFECT_WARNING =
  'the events had no visible effect: no sink calls, and the probe state after the run equals the state right after reset. ' +
  'Rules that look at effects pass without testing anything. Common causes: reset removes the rows the events refer to ' +
  '(seed them instead), the handler ignores these event types, side effects are not pointed at the sink, or the app ' +
  'processes webhooks in the background and needs a longer --settle.';

export interface SuiteResult {
  config: ResolvedConfig;
  runs: RunResult[];
  /** Invariant names that were violated at least once. */
  failedInvariants: string[];
  passed: boolean;
  /** Every run raised the no-effect warning: the suite tested nothing, so it is not a pass. */
  inconclusive: boolean;
  /** How many times each seed was run (`--repeat-seed`); 1 normally. */
  repeat: number;
  durationMs: number;
}

export interface RunHooks {
  onRunStart?(seed: number, index: number, total: number): void;
  onRunEnd?(result: RunResult, index: number, total: number): void;
}

async function callHook(
  hook: string | (() => unknown) | undefined,
  method: 'POST' | 'GET',
): Promise<unknown> {
  if (hook === undefined) return undefined;
  if (typeof hook === 'function') return await hook();
  const res = await fetch(hook, { method, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${method} ${hook} answered ${res.status}`);
  if (method === 'GET') return res.json();
  return undefined;
}

/** One seed: reset, deliver the plan, settle, probe, check invariants. */
export async function runOnce(cfg: ResolvedConfig, sink: SinkServer, seed: number): Promise<RunResult> {
  const started = performance.now();
  const plan = buildPlan({
    eventIds: cfg.events.map((e) => e.id),
    profile: cfg.profile,
    profileName: cfg.profileName,
    seed,
    maxAttempts: cfg.maxAttempts,
  });
  const empty = {
    seed,
    plan,
    deliveries: [],
    sink: [],
    state: undefined,
    violations: [],
    warnings: [],
    repeat: 1,
  };

  try {
    await callHook(cfg.reset, 'POST');
  } catch (e) {
    return {
      ...empty,
      durationMs: performance.now() - started,
      fatal: `reset failed: ${(e as Error).message}`,
    };
  }

  // State right after reset, to tell whether the events changed anything at all.
  let baseline: unknown;
  if (cfg.probe !== undefined) baseline = await callHook(cfg.probe, 'GET').catch(() => undefined);

  const t0 = performance.now();
  sink.reset(seed, t0);
  const byId = new Map<string, WebhookEvent>(cfg.events.map((e) => [e.id, e]));
  const deliveries = await executePlan(plan, byId, {
    target: cfg.target,
    preset: cfg.preset,
    secret: cfg.secret,
    timeoutMs: cfg.timeoutMs,
    maxAttempts: cfg.maxAttempts,
    backoffMs: cfg.backoffMs,
    t0,
  });

  const attempts = deliveries.flatMap((d) => d.attempts);
  const sent = attempts.filter((a) => a.outcome !== 'notSent');
  if (sent.length > 0 && sent.every((a) => a.outcome === 'error')) {
    return {
      ...empty,
      deliveries,
      durationMs: performance.now() - started,
      fatal: `could not reach ${cfg.target}: ${sent[0]!.error ?? 'connection error'}`,
    };
  }

  await sleep(cfg.settleMs);
  const sinkCalls = sink.calls.slice();

  let state: unknown;
  const violations: Violation[] = [];
  try {
    state = await callHook(cfg.probe, 'GET');
  } catch (e) {
    violations.push({ invariant: 'probe', message: `probe failed: ${(e as Error).message}` });
  }

  const ackedEvents = new Set(deliveries.filter((d) => d.acked).map((d) => d.eventId));
  const obs: Observations = {
    seed,
    events: cfg.events,
    plan,
    deliveries,
    sink: sinkCalls,
    state,
    baseline,
    isAcked: (id) => ackedEvents.has(id),
  };
  for (const inv of cfg.invariants) {
    try {
      violations.push(...(await inv.check(obs)));
    } catch (e) {
      violations.push({ invariant: inv.name, message: `invariant threw: ${(e as Error).message}` });
    }
  }
  return {
    seed,
    plan,
    deliveries,
    sink: sinkCalls,
    state,
    violations,
    warnings: runWarnings(cfg, deliveries, sinkCalls, baseline, state),
    repeat: 1,
    durationMs: performance.now() - started,
  };
}

/** The target refused or never answered a TCP connection. */
export class UnreachableError extends Error {}

/**
 * Checks the target accepts TCP connections before any run starts. Without this, a receiver that isn't running
 * looks like a stream of timeouts on platforms where refused connections are slow to fail (Windows).
 */
export function checkReachable(target: string, timeoutMs = 5000): Promise<void> {
  const u = new URL(target);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (why: string) => {
      socket.destroy();
      reject(new UnreachableError(`could not reach ${target}: ${why}. Is the receiver running?`));
    };
    socket.setTimeout(timeoutMs, () => fail(`no answer within ${timeoutMs}ms`));
    socket.once('error', (e) => fail(e.message));
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
  });
}

function runWarnings(
  cfg: ResolvedConfig,
  deliveries: DeliveryRecord[],
  sinkCalls: SinkCall[],
  baseline: unknown,
  state: unknown,
): string[] {
  const warnings: string[] = [];
  const attempts = deliveries.flatMap((d) => d.attempts);
  const answered = attempts.filter((a) => a.status !== undefined);

  if (!deliveries.some((d) => d.acked)) {
    const statuses = [...new Set(answered.map((a) => a.status))].join(', ');
    warnings.push(
      `no delivery was acknowledged${statuses ? ` (the app answered ${statuses})` : ''}. ` +
        'A 400/401 usually means the signing secret does not match the one the app verifies with.',
    );
    return warnings;
  }

  const sinkUsed = sinkCalls.some((c) => c.ok);
  const stateChanged = cfg.probe !== undefined && state !== undefined && !isDeepStrictEqual(baseline, state);
  if (!sinkUsed && !stateChanged) {
    warnings.push(
      cfg.probe === undefined
        ? 'nothing was observed: no sink calls, and no probe is configured. Point side effects at the sink or add a probe.'
        : NO_EFFECT_WARNING,
    );
  }
  return warnings;
}

export async function runSuite(
  cfg: ResolvedConfig,
  seeds: number[],
  hooks: RunHooks = {},
): Promise<SuiteResult> {
  const started = performance.now();
  await checkReachable(cfg.target);
  const sink = new SinkServer(cfg.sinkFaults);
  try {
    await sink.start(cfg.sinkPort, cfg.sinkHost);
  } catch (e) {
    throw new Error(`could not start sink on ${cfg.sinkHost}:${cfg.sinkPort}: ${(e as Error).message}`, {
      cause: e,
    });
  }
  const runs: RunResult[] = [];
  const timesRun = new Map<number, number>();
  try {
    for (let i = 0; i < seeds.length; i++) {
      hooks.onRunStart?.(seeds[i]!, i, seeds.length);
      const r = await runOnce(cfg, sink, seeds[i]!);
      r.repeat = (timesRun.get(r.seed) ?? 0) + 1;
      timesRun.set(r.seed, r.repeat);
      runs.push(r);
      hooks.onRunEnd?.(r, i, seeds.length);
      if (r.fatal) break;
    }
  } finally {
    await sink.stop();
  }
  const failedInvariants = [...new Set(runs.flatMap((r) => r.violations.map((v) => v.invariant)))];
  const inconclusive = runs.length > 0 && runs.every((r) => r.warnings.length > 0);
  return {
    config: cfg,
    runs,
    failedInvariants,
    inconclusive,
    repeat: Math.max(1, ...timesRun.values()),
    passed: !inconclusive && runs.every((r) => !r.fatal && r.violations.length === 0),
    durationMs: performance.now() - started,
  };
}

/**
 * Seeds for a suite: `runs` consecutive seeds from `base`, each run `repeat` times in a row. Repeating a seed
 * replays the same plan; only the app's own timing differs, so it measures how often a race actually fails.
 */
export function seedsFor(base: number, runs: number, repeat = 1): number[] {
  const seeds = Array.from({ length: Math.max(1, runs) }, (_, i) => (base + i) % 2 ** 31 || 1);
  return seeds.flatMap((s) => Array<number>(Math.max(1, repeat)).fill(s));
}

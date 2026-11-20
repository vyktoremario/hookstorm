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
}

export interface SuiteResult {
  config: ResolvedConfig;
  runs: RunResult[];
  /** Invariant names that were violated at least once. */
  failedInvariants: string[];
  passed: boolean;
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
  const empty = { seed, plan, deliveries: [], sink: [], state: undefined, violations: [] };

  try {
    await callHook(cfg.reset, 'POST');
  } catch (e) {
    return {
      ...empty,
      durationMs: performance.now() - started,
      fatal: `reset failed: ${(e as Error).message}`,
    };
  }

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
    durationMs: performance.now() - started,
  };
}

export async function runSuite(
  cfg: ResolvedConfig,
  seeds: number[],
  hooks: RunHooks = {},
): Promise<SuiteResult> {
  const started = performance.now();
  const sink = new SinkServer(cfg.sinkFaults);
  try {
    await sink.start(cfg.sinkPort, cfg.sinkHost);
  } catch (e) {
    throw new Error(`could not start sink on ${cfg.sinkHost}:${cfg.sinkPort}: ${(e as Error).message}`, {
      cause: e,
    });
  }
  const runs: RunResult[] = [];
  try {
    for (let i = 0; i < seeds.length; i++) {
      hooks.onRunStart?.(seeds[i]!, i, seeds.length);
      const r = await runOnce(cfg, sink, seeds[i]!);
      runs.push(r);
      hooks.onRunEnd?.(r, i, seeds.length);
      if (r.fatal) break;
    }
  } finally {
    await sink.stop();
  }
  const failedInvariants = [...new Set(runs.flatMap((r) => r.violations.map((v) => v.invariant)))];
  return {
    config: cfg,
    runs,
    failedInvariants,
    passed: runs.every((r) => !r.fatal && r.violations.length === 0),
    durationMs: performance.now() - started,
  };
}

export function seedsFor(base: number, runs: number): number[] {
  return Array.from({ length: runs }, (_, i) => (base + i) % 2 ** 31 || 1);
}

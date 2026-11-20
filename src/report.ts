import pc from 'picocolors';
import type { RunResult, SuiteResult } from './runner.js';
import { describeFaults } from './scenario.js';
import type { AttemptRecord, SinkCall, Violation } from './types.js';

const fmtMs = (ms: number) => `${Math.round(ms)}ms`.padStart(7);

const OUTCOME_TEXT: Record<AttemptRecord['outcome'], string> = {
  acked: 'acknowledged',
  rejected: 'rejected',
  notSent: 'request dropped before reaching the app',
  responseDropped: 'response dropped (app processed it, provider saw a failure)',
  timedOut: 'timed out waiting for the app',
  aborted: 'connection cut mid-flight (timeout fault)',
  error: 'connection error',
};

function attemptLine(a: AttemptRecord, type: string): string {
  const status = a.status !== undefined ? ` ${a.status}` : '';
  const text = `${OUTCOME_TEXT[a.outcome]}${a.outcome === 'acked' || a.outcome === 'rejected' ? status : ''}`;
  const colour = a.outcome === 'acked' ? pc.green : pc.yellow;
  return `${pc.dim(fmtMs(a.startedAt))}  deliver ${pc.bold(a.deliveryId)} (${type}) attempt ${a.attempt} → ${colour(text)}`;
}

function sinkLine(c: SinkCall): string {
  const status = c.ok ? pc.green(String(c.status)) : pc.red(`${c.status} (failed, injected)`);
  return `${pc.dim(fmtMs(c.at))}  ${pc.cyan('side effect')} ${pc.bold(c.effect)} → ${status}`;
}

/** Interleaves the deliveries and side effects behind a violation, in time order. */
function relatedEvents(v: Violation, suite: SuiteResult): Set<string> {
  const eventIds = new Set(v.eventIds ?? []);
  if (v.key !== undefined)
    for (const e of suite.config.events) if (suite.config.eventKey(e) === v.key) eventIds.add(e.id);
  return eventIds;
}

export function timeline(run: RunResult, v: Violation, suite: SuiteResult): string[] {
  const cfg = suite.config;
  const eventIds = relatedEvents(v, suite);
  const typeOf = new Map(cfg.events.map((e) => [e.id, e.type]));
  const rows: Array<{ t: number; line: string }> = [];
  for (const d of run.deliveries)
    if (eventIds.has(d.eventId))
      for (const a of d.attempts)
        rows.push({ t: a.startedAt, line: attemptLine(a, typeOf.get(a.eventId) ?? '?') });
  const calls = v.sinkCalls ?? [];
  for (const c of calls) rows.push({ t: c.at, line: sinkLine(c) });
  return rows.sort((a, b) => a.t - b.t).map((r) => r.line);
}

export function rerunCommand(suite: SuiteResult, seed: number): string {
  const c = suite.config.configPath ? ` -c ${suite.config.configPath}` : '';
  return `hookstorm run${c} --target ${suite.config.target} --seed ${seed} --runs 1`;
}

export function formatRunLine(r: RunResult, i: number, total: number): string {
  const n = `[${String(i + 1).padStart(String(total).length)}/${total}]`;
  const plan = describeFaults(r.plan);
  const attempts = r.deliveries.flatMap((d) => d.attempts);
  const count = (...o: AttemptRecord['outcome'][]) => attempts.filter((a) => o.includes(a.outcome)).length;
  const summary = pc.dim(
    `${attempts.length} attempts: ${plan.duplicates} dup, ${plan.concurrent} concurrent, ${count('notSent')} dropped requests, ${count('responseDropped')} dropped responses, ${count('timedOut', 'aborted')} timeouts`,
  );
  if (r.fatal) return `${n} seed ${r.seed}  ${pc.red('ERROR')} ${r.fatal}`;
  if (r.violations.length === 0) return `${n} seed ${r.seed}  ${pc.green('pass')}  ${summary}`;
  return `${n} seed ${r.seed}  ${pc.red(`${r.violations.length} violation(s)`)}  ${summary}`;
}

/** Full human-readable report. Shows each distinct invariant once, with its first reproduction. */
export function formatSuite(suite: SuiteResult, opts: { maxExamples?: number } = {}): string {
  const out: string[] = [''];
  const failing = suite.runs.filter((r) => r.violations.length > 0);
  const fatal = suite.runs.find((r) => r.fatal);
  if (fatal) {
    out.push(pc.red(pc.bold(`✗ ${fatal.fatal}`)));
    out.push(pc.dim('  Is the receiver running, and does the target URL match?'));
    return out.join('\n');
  }
  if (failing.length === 0) {
    out.push(
      pc.green(
        pc.bold(
          `✓ All ${suite.config.invariants.length} invariants held across ${suite.runs.length} seed(s)`,
        ),
      ) + pc.dim(` (${(suite.durationMs / 1000).toFixed(1)}s)`),
    );
    return out.join('\n');
  }

  const byInvariant = new Map<string, Array<{ run: RunResult; v: Violation }>>();
  for (const run of failing)
    for (const v of run.violations) {
      const list = byInvariant.get(v.invariant) ?? [];
      list.push({ run, v });
      byInvariant.set(v.invariant, list);
    }

  for (const [name, hits] of byInvariant) {
    const seeds = [...new Set(hits.map((h) => h.run.seed))];
    out.push(pc.red(pc.bold(`✗ ${name}`)));
    out.push(pc.dim(`  violated ${hits.length}× across ${seeds.length}/${suite.runs.length} seed(s)`));
    for (const { run, v } of hits.slice(0, opts.maxExamples ?? 1)) {
      out.push(`  ${v.message}  ${pc.dim(`(seed ${run.seed})`)}`);
      const related = relatedEvents(v, suite);
      const concurrent = run.plan.deliveries.some((d) => d.concurrentWith && related.has(d.eventId));
      for (const line of timeline(run, v, suite)) out.push(`    ${line}`);
      out.push(pc.dim(`    reproduce: ${rerunCommand(suite, run.seed)}`));
      if (concurrent)
        out.push(pc.dim('    note: this plan includes concurrent deliveries; races may be timing-dependent'));
    }
    out.push('');
  }
  out.push(
    pc.red(
      pc.bold(
        `${byInvariant.size} of ${suite.config.invariants.length} invariants violated in ${failing.length}/${suite.runs.length} seed(s)`,
      ),
    ),
  );
  return out.join('\n');
}

export function toJson(suite: SuiteResult): object {
  return {
    tool: 'hookstorm',
    passed: suite.passed,
    target: suite.config.target,
    provider: suite.config.preset.name,
    profile: suite.config.profileName,
    durationMs: Math.round(suite.durationMs),
    invariants: suite.config.invariants.map((i) => i.name),
    failedInvariants: suite.failedInvariants,
    runs: suite.runs.map((r) => ({
      seed: r.seed,
      passed: !r.fatal && r.violations.length === 0,
      fatal: r.fatal,
      durationMs: Math.round(r.durationMs),
      violations: r.violations.map((v) => ({ ...v, sinkCalls: v.sinkCalls?.map((c) => c.seq) })),
      plan: r.plan,
      deliveries: r.deliveries,
      sink: r.sink.map(({ raw: _raw, headers: _headers, ...c }) => c),
      state: r.state,
    })),
  };
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JUnit XML: one test case per (seed, invariant), so CI systems show exactly what failed. */
export function toJunit(suite: SuiteResult): string {
  const cases: string[] = [];
  let failures = 0;
  for (const run of suite.runs) {
    for (const inv of suite.config.invariants) {
      const vs = run.violations.filter((v) => v.invariant === inv.name);
      const name = xml(`${inv.name} [seed ${run.seed}]`);
      if (run.fatal) {
        failures++;
        cases.push(
          `    <testcase classname="hookstorm" name="${name}"><error message="${xml(run.fatal)}"/></testcase>`,
        );
      } else if (vs.length) {
        failures++;
        const msg = vs.map((v) => v.message).join('\n');
        cases.push(
          `    <testcase classname="hookstorm" name="${name}"><failure message="${xml(vs[0]!.message)}">${xml(`${msg}\nreproduce: ${rerunCommand(suite, run.seed)}`)}</failure></testcase>`,
        );
      } else cases.push(`    <testcase classname="hookstorm" name="${name}"/>`);
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="hookstorm" tests="${cases.length}" failures="${failures}" time="${(suite.durationMs / 1000).toFixed(3)}">`,
    `  <testsuite name="hookstorm" tests="${cases.length}" failures="${failures}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

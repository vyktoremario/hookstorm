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

/**
 * Interleaves the deliveries and side effects behind a violation, in time order. Events whose type is in
 * `ignoredEventTypes` (types the app doesn't handle) are left out unless `full` is set.
 */
export function timeline(
  run: RunResult,
  v: Violation,
  suite: SuiteResult,
  full = false,
): { lines: string[]; hidden: number } {
  const cfg = suite.config;
  const named = new Set(v.eventIds ?? []);
  const ignored = new Set(cfg.ignoredEventTypes);
  const typeOf = new Map(cfg.events.map((e) => [e.id, e.type]));
  const rows: Array<{ t: number; line: string }> = [];
  let hidden = 0;
  for (const id of relatedEvents(v, suite)) {
    if (!full && !named.has(id) && ignored.has(typeOf.get(id) ?? '')) {
      hidden++;
      continue;
    }
    for (const d of run.deliveries)
      if (d.eventId === id)
        for (const a of d.attempts)
          rows.push({ t: a.startedAt, line: attemptLine(a, typeOf.get(id) ?? '?') });
  }
  for (const c of v.sinkCalls ?? []) rows.push({ t: c.at, line: sinkLine(c) });
  return { lines: rows.sort((a, b) => a.t - b.t).map((r) => r.line), hidden };
}

/** Did two deliveries of the same related event have attempts in flight at the same time? */
function overlapped(run: RunResult, eventIds: Set<string>): boolean {
  for (const id of eventIds) {
    const spans = run.deliveries
      .filter((d) => d.eventId === id)
      .map((d) =>
        d.attempts.filter((a) => a.outcome !== 'notSent').map((a) => [a.startedAt, a.endedAt] as const),
      );
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++)
        for (const [s1, e1] of spans[i]!)
          for (const [s2, e2] of spans[j]!) if (s1 < e2 && s2 < e1) return true;
  }
  return false;
}

export function rerunCommand(suite: SuiteResult, seed: number, repeat = 1): string {
  const c = suite.config.configPath ? ` -c ${suite.config.configPath}` : '';
  const r = repeat > 1 ? ` --repeat-seed ${repeat}` : '';
  return `hookstorm run${c} --target ${suite.config.target} --seed ${seed} --runs 1${r}`;
}

/**
 * With --repeat-seed: how often the invariant failed for each seed. A seed that fails on every repeat is
 * deterministic (ordering, retries); one that fails on some repeats depends on the app's timing (a race).
 */
function failureRates(suite: SuiteResult, invariant: string): string {
  const bySeed = new Map<number, { failed: number; total: number }>();
  for (const r of suite.runs) {
    const e = bySeed.get(r.seed) ?? { failed: 0, total: 0 };
    e.total++;
    if (r.violations.some((v) => v.invariant === invariant)) e.failed++;
    bySeed.set(r.seed, e);
  }
  const failing = [...bySeed].filter(([, e]) => e.failed > 0);
  const parts = failing
    .slice(0, 8)
    .map(([seed, e]) =>
      e.failed === e.total
        ? `seed ${seed}: every run`
        : `seed ${seed}: ${e.failed}/${e.total} runs (timing-dependent)`,
    );
  const more = failing.length > 8 ? `, and ${failing.length - 8} more seed(s)` : '';
  return `failure rate: ${parts.join(', ')}${more}`;
}

export function formatRunLine(r: RunResult, i: number, total: number, repeat = 1): string {
  const n = `[${String(i + 1).padStart(String(total).length)}/${total}]`;
  const seedLabel = repeat > 1 ? `${r.seed} (${r.repeat}/${repeat})` : String(r.seed);
  const plan = describeFaults(r.plan);
  const attempts = r.deliveries.flatMap((d) => d.attempts);
  const count = (...o: AttemptRecord['outcome'][]) => attempts.filter((a) => o.includes(a.outcome)).length;
  const summary = pc.dim(
    `${attempts.length} attempts: ${plan.duplicates} dup, ${plan.concurrent} concurrent, ${count('notSent')} dropped requests, ${count('responseDropped')} dropped responses, ${count('timedOut', 'aborted')} timeouts`,
  );
  const warn = r.warnings.length ? `  ${pc.yellow('⚠ warning')}` : '';
  if (r.fatal) return `${n} seed ${seedLabel}  ${pc.red('ERROR')} ${r.fatal}`;
  if (r.violations.length === 0) return `${n} seed ${seedLabel}  ${pc.green('pass')}${warn}  ${summary}`;
  return `${n} seed ${seedLabel}  ${pc.red(`${r.violations.length} violation(s)`)}${warn}  ${summary}`;
}

/** Distinct warnings across runs, each with how many seeds raised it. */
function formatWarnings(suite: SuiteResult): string[] {
  const counts = new Map<string, number>();
  for (const r of suite.runs) for (const w of r.warnings) counts.set(w, (counts.get(w) ?? 0) + 1);
  if (counts.size === 0) return [];
  const out = [pc.yellow(pc.bold('⚠ Warnings'))];
  for (const [w, n] of counts)
    out.push(`  ${pc.yellow(w)} ${pc.dim(`(${n}/${suite.runs.length} seed(s))`)}`, '');
  return out;
}

/** Full human-readable report. Shows each distinct invariant once, with its first reproduction. */
export function formatSuite(
  suite: SuiteResult,
  opts: { maxExamples?: number; fullTimeline?: boolean } = {},
): string {
  const out: string[] = [''];
  const failing = suite.runs.filter((r) => r.violations.length > 0);
  const fatal = suite.runs.find((r) => r.fatal);
  if (fatal) {
    out.push(pc.red(pc.bold(`✗ ${fatal.fatal}`)));
    out.push(pc.dim('  Is the receiver running, and does the target URL match?'));
    return out.join('\n');
  }
  const warnings = formatWarnings(suite);
  if (failing.length === 0) {
    if (suite.inconclusive) {
      out.push(...warnings);
      out.push(
        pc.yellow(
          pc.bold(
            `⚠ Inconclusive: every run raised a warning, so the ${suite.config.invariants.length} invariants passing proves nothing`,
          ),
        ),
      );
      return out.join('\n');
    }
    out.push(
      pc.green(
        pc.bold(
          `✓ All ${suite.config.invariants.length} invariants held across ${
            suite.repeat > 1
              ? `${new Set(suite.runs.map((r) => r.seed)).size} seed(s) × ${suite.repeat} runs`
              : `${suite.runs.length} seed(s)`
          }`,
        ),
      ) + pc.dim(` (${(suite.durationMs / 1000).toFixed(1)}s)`),
    );
    if (warnings.length) out.push('', ...warnings);
    return out.join('\n');
  }

  const byInvariant = new Map<string, Array<{ run: RunResult; v: Violation }>>();
  for (const run of failing)
    for (const v of run.violations) {
      const list = byInvariant.get(v.invariant) ?? [];
      list.push({ run, v });
      byInvariant.set(v.invariant, list);
    }

  const allSeeds = new Set(suite.runs.map((r) => r.seed));
  for (const [name, hits] of byInvariant) {
    const seeds = [...new Set(hits.map((h) => h.run.seed))];
    const failedRuns = new Set(hits.map((h) => h.run));
    out.push(pc.red(pc.bold(`✗ ${name}`)));
    out.push(
      pc.dim(
        suite.repeat > 1
          ? `  violated ${hits.length}× in ${failedRuns.size}/${suite.runs.length} runs (${seeds.length}/${allSeeds.size} seed(s), each run ${suite.repeat}×)`
          : `  violated ${hits.length}× across ${seeds.length}/${allSeeds.size} seed(s)`,
      ),
    );
    if (suite.repeat > 1) out.push(pc.dim(`  ${failureRates(suite, name)}`));
    for (const { run, v } of hits.slice(0, opts.maxExamples ?? 1)) {
      out.push(`  ${v.message}  ${pc.dim(`(seed ${run.seed})`)}`);
      const { lines, hidden } = timeline(run, v, suite, opts.fullTimeline);
      for (const line of lines) out.push(`    ${line}`);
      if (hidden)
        out.push(
          pc.dim(`    (${hidden} related event(s) of ignored types hidden; --full-timeline shows them)`),
        );
      out.push(pc.dim(`    reproduce: ${rerunCommand(suite, run.seed)}`));
      if (overlapped(run, relatedEvents(v, suite)) && suite.repeat === 1)
        out.push(
          pc.dim(
            '    note: two deliveries of the same event were in flight at once; a race may not fail on every rerun.\n' +
              `    To see how often it fails: ${rerunCommand(suite, run.seed, 20)}`,
          ),
        );
    }
    out.push('');
  }
  out.push(...warnings);
  out.push(
    pc.red(
      pc.bold(
        suite.repeat > 1
          ? `${byInvariant.size} of ${suite.config.invariants.length} invariants violated in ${failing.length}/${suite.runs.length} runs`
          : `${byInvariant.size} of ${suite.config.invariants.length} invariants violated in ${failing.length}/${suite.runs.length} seed(s)`,
      ),
    ),
  );
  return out.join('\n');
}

export function toJson(suite: SuiteResult): object {
  return {
    tool: 'hookstorm',
    passed: suite.passed,
    inconclusive: suite.inconclusive,
    repeat: suite.repeat,
    target: suite.config.target,
    provider: suite.config.preset.name,
    profile: suite.config.profileName,
    durationMs: Math.round(suite.durationMs),
    invariants: suite.config.invariants.map((i) => i.name),
    failedInvariants: suite.failedInvariants,
    runs: suite.runs.map((r) => ({
      seed: r.seed,
      repeat: r.repeat,
      passed: !r.fatal && r.violations.length === 0,
      fatal: r.fatal,
      warnings: r.warnings,
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
      const name = xml(
        `${inv.name} [seed ${run.seed}${suite.repeat > 1 ? `, run ${run.repeat}/${suite.repeat}` : ''}]`,
      );
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
  if (suite.inconclusive) {
    // Exit code 2 says "nothing was tested"; make CI's test view say the same instead of all green.
    failures++;
    const msg = [...new Set(suite.runs.flatMap((r) => r.warnings))].join('\n');
    cases.push(
      `    <testcase classname="hookstorm" name="events had a visible effect"><failure message="inconclusive: every run raised a warning">${xml(msg)}</failure></testcase>`,
    );
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

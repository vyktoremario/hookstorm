import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { custom } from '../src/invariants.js';
import { formatSuite, toJunit } from '../src/report.js';
import type { RunResult, SuiteResult } from '../src/runner.js';
import type { AttemptRecord, DeliveryRecord } from '../src/types.js';

const attempt = (deliveryId: string, startedAt: number, endedAt: number): AttemptRecord => ({
  deliveryId,
  eventId: deliveryId.split('#')[0]!,
  attempt: 1,
  fault: 'none',
  startedAt,
  endedAt,
  status: 200,
  outcome: 'acked',
});
const delivery = (deliveryId: string, start: number, end: number): DeliveryRecord => ({
  deliveryId,
  eventId: deliveryId.split('#')[0]!,
  copy: Number(deliveryId.split('#')[1]),
  attempts: [attempt(deliveryId, start, end)],
  acked: true,
});

async function suiteWith(
  deliveries: DeliveryRecord[],
  ignoredEventTypes: string[] = [],
  repeats: boolean[] = [true],
): Promise<SuiteResult> {
  const config = await resolveConfig({
    target: 'http://127.0.0.1:1/x',
    provider: 'stripe',
    secret: 'whsec_x',
    events: [
      {
        id: 'created',
        body: { type: 'payment_intent.created', data: { object: { metadata: { order: 'o1' } } } },
      },
      {
        id: 'paid',
        body: { type: 'payment_intent.succeeded', data: { object: { metadata: { order: 'o1' } } } },
      },
    ],
    eventKey: (e) => e.json.data.object.metadata.order,
    ignoredEventTypes,
    invariants: [custom('paid once', () => [])],
  });
  // One run per entry in `repeats` (all seed 7); `true` means that run violated the invariant.
  const runs: RunResult[] = repeats.map((failed, i) => ({
    seed: 7,
    plan: { seed: 7, profile: 'x', order: [], deliveries: [] },
    deliveries,
    sink: [],
    state: {},
    violations: failed ? [{ invariant: 'paid once', key: 'o1', message: 'o1 paid twice' }] : [],
    warnings: [],
    repeat: i + 1,
    durationMs: 1,
  }));
  return {
    config,
    runs,
    failedInvariants: ['paid once'],
    passed: false,
    inconclusive: false,
    repeat: repeats.length,
    durationMs: 1,
  };
}

describe('formatSuite timelines', () => {
  it('leaves out ignored event types unless asked, and says so', async () => {
    const s = await suiteWith(
      [delivery('created#0', 0, 5), delivery('paid#0', 10, 20)],
      ['payment_intent.created'],
    );
    const out = formatSuite(s);
    expect(out).toContain('paid#0');
    expect(out).not.toContain('created#0');
    expect(out).toContain('1 related event(s) of ignored types hidden');
    expect(formatSuite(s, { fullTimeline: true })).toContain('created#0');
  });

  it('adds the race note only when two deliveries of one event overlapped', async () => {
    const overlapping = await suiteWith([delivery('paid#0', 10, 30), delivery('paid#1', 12, 28)]);
    expect(formatSuite(overlapping)).toMatch(/in flight at once/);
    expect(formatSuite(overlapping)).toContain('--seed 7 --runs 1 --repeat-seed 20');
    const sequential = await suiteWith([delivery('paid#0', 10, 20), delivery('paid#1', 50, 60)]);
    expect(formatSuite(sequential)).not.toMatch(/in flight at once/);
  });
});

describe('--repeat-seed reporting', () => {
  it('reports a seed that failed on every repeat as deterministic', async () => {
    const s = await suiteWith([delivery('paid#0', 10, 20)], [], [true, true, true]);
    const out = formatSuite(s);
    expect(out).toContain('in 3/3 runs');
    expect(out).toContain('failure rate: seed 7: every run');
  });

  it('reports a seed that failed on some repeats as timing-dependent, without repeating the race hint', async () => {
    const s = await suiteWith(
      [delivery('paid#0', 10, 30), delivery('paid#1', 12, 28)],
      [],
      [true, false, true, false],
    );
    const out = formatSuite(s);
    expect(out).toContain('failure rate: seed 7: 2/4 runs (timing-dependent)');
    expect(out).not.toContain('--repeat-seed 20');
  });

  it('gives each repeat its own JUnit test case', async () => {
    const s = await suiteWith([delivery('paid#0', 10, 20)], [], [true, false]);
    const xml = toJunit(s);
    expect(xml).toContain('name="paid once [seed 7, run 1/2]"');
    expect(xml).toContain('name="paid once [seed 7, run 2/2]"');
  });
});

describe('passing suites with --repeat-seed', () => {
  it('counts seeds × runs, not runs as seeds', async () => {
    const s = await suiteWith([], [], [false, false, false]);
    s.failedInvariants = [];
    s.passed = true;
    expect(formatSuite(s)).toContain('held across 1 seed(s) × 3 runs');
  });
});

import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { custom } from '../src/invariants.js';
import { formatSuite } from '../src/report.js';
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
  const run: RunResult = {
    seed: 7,
    plan: { seed: 7, profile: 'x', order: [], deliveries: [] },
    deliveries,
    sink: [],
    state: {},
    violations: [{ invariant: 'paid once', key: 'o1', message: 'o1 paid twice' }],
    warnings: [],
    durationMs: 1,
  };
  return {
    config,
    runs: [run],
    failedInvariants: ['paid once'],
    passed: false,
    inconclusive: false,
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
    const sequential = await suiteWith([delivery('paid#0', 10, 20), delivery('paid#1', 50, 60)]);
    expect(formatSuite(sequential)).not.toMatch(/in flight at once/);
  });
});

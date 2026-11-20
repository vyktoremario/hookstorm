import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { github, paystack, type ProviderPreset } from '../src/presets.js';
import { executePlan } from '../src/simulator.js';
import type { AttemptFault, DeliveryPlan, WebhookEvent } from '../src/types.js';
import { events, fakeReceiver } from './helpers.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const one = (
  faults: AttemptFault['kind'][],
  extra: Partial<DeliveryPlan['deliveries'][0]> = {},
): DeliveryPlan => ({
  seed: 1,
  profile: 'test',
  order: ['e1'],
  deliveries: [
    {
      deliveryId: 'e1#0',
      eventId: 'e1',
      copy: 0,
      startAtMs: 0,
      delayMs: 0,
      faults: faults.map((kind) => ({ kind, abortAfterMs: 5 })),
      ...extra,
    },
  ],
});

async function run(
  plan: DeliveryPlan,
  url: string,
  preset: ProviderPreset = paystack,
  evs: WebhookEvent[] = events({ event: 'charge.success', data: { reference: 'r1' } }),
  timeoutMs = 200,
) {
  return executePlan(plan, new Map(evs.map((e) => [e.id, e])), {
    target: url,
    preset,
    secret: 'sk_test',
    timeoutMs,
    maxAttempts: plan.deliveries[0]!.faults.length,
    backoffMs: [5],
    t0: performance.now(),
  });
}

describe('executePlan', () => {
  it('sends the exact body, signed, with hookstorm headers', async () => {
    const rx = await fakeReceiver();
    close = rx.close;
    const evs = events({ event: 'charge.success', data: { reference: 'r1' } });
    const [d] = await run(one(['none']), rx.url, paystack, evs);
    expect(d!.acked).toBe(true);
    const req = rx.requests[0]!;
    expect(req.body).toBe(evs[0]!.body);
    expect(req.headers['x-paystack-signature']).toBe(
      createHmac('sha512', 'sk_test').update(req.body).digest('hex'),
    );
    expect(req.headers['x-hookstorm-delivery']).toBe('e1#0');
    expect(req.headers['x-hookstorm-attempt']).toBe('1');
  });

  it('dropRequest: the app never sees the attempt; the provider retries', async () => {
    const rx = await fakeReceiver();
    close = rx.close;
    const [d] = await run(one(['dropRequest', 'none']), rx.url);
    expect(d!.attempts.map((a) => a.outcome)).toEqual(['notSent', 'acked']);
    expect(rx.requests).toHaveLength(1);
  });

  it('dropResponse: the app processes it, the provider still retries', async () => {
    const rx = await fakeReceiver();
    close = rx.close;
    const [d] = await run(one(['dropResponse', 'none']), rx.url);
    expect(d!.attempts.map((a) => [a.outcome, a.status])).toEqual([
      ['responseDropped', 200],
      ['acked', 200],
    ]);
    expect(rx.requests).toHaveLength(2);
  });

  it('timeout fault: cuts the connection after the request reached the app', async () => {
    const rx = await fakeReceiver(() => ({ delayMs: 100 }));
    close = rx.close;
    const [d] = await run(one(['timeout', 'none']), rx.url);
    expect(d!.attempts.map((a) => a.outcome)).toEqual(['aborted', 'acked']);
    expect(rx.requests).toHaveLength(2);
  });

  it('slow app: times out at timeoutMs and retries', async () => {
    const rx = await fakeReceiver((_r, n) => ({ delayMs: n === 1 ? 400 : 0 }));
    close = rx.close;
    const [d] = await run(one(['none', 'none']), rx.url);
    expect(d!.attempts.map((a) => a.outcome)).toEqual(['timedOut', 'acked']);
  });

  it("uses the preset's notion of success (Paystack: 201 is a failure)", async () => {
    const rx = await fakeReceiver((_r, n) => ({ status: n === 1 ? 201 : 200 }));
    close = rx.close;
    const [d] = await run(one(['none', 'none']), rx.url);
    expect(d!.attempts.map((a) => [a.outcome, a.status])).toEqual([
      ['rejected', 201],
      ['acked', 200],
    ]);
  });

  it('stops after maxAttempts and leaves the delivery unacknowledged', async () => {
    const rx = await fakeReceiver(() => ({ status: 500 }));
    close = rx.close;
    const [d] = await run(one(['none', 'none', 'none']), rx.url);
    expect(d!.attempts).toHaveLength(3);
    expect(d!.acked).toBe(false);
  });

  it('GitHub: a single dropped attempt loses the event', async () => {
    const rx = await fakeReceiver();
    close = rx.close;
    const evs = events({ zen: 'hi' });
    const [d] = await run(one(['dropRequest']), rx.url, github, evs);
    expect(d!.acked).toBe(false);
    expect(rx.requests).toHaveLength(0);
  });

  it('runs concurrent deliveries in parallel', async () => {
    const rx = await fakeReceiver(() => ({ delayMs: 300 }));
    close = rx.close;
    const plan = one(['none']);
    plan.deliveries.push({ ...plan.deliveries[0]!, deliveryId: 'e1#1', copy: 1, concurrentWith: 'e1#0' });
    await run(plan, rx.url);
    expect(rx.requests).toHaveLength(2);
    // Both requests arrive before the first response could have been sent.
    expect(Math.abs(rx.requests[0]!.at - rx.requests[1]!.at)).toBeLessThan(250);
  });

  it('records connection errors', async () => {
    // Generous timeout: on Windows a refused connection takes ~2 s to surface as an error.
    const [d] = await run(one(['none']), 'http://127.0.0.1:1/nothing-here', paystack, undefined, 10_000);
    expect(d!.attempts[0]!.outcome).toBe('error');
  });
});

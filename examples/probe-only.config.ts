import { createHmac } from 'node:crypto';
import { custom, defineConfig } from 'hookstorm-cli';

// A provider with no preset, observed through a state probe only. See docs/guide-your-own-receiver.md.
export default defineConfig({
  target: 'http://127.0.0.1:3003/webhooks',
  provider: 'custom',
  sign: ({ body, secret }) => ({ 'x-signature': createHmac('sha256', secret).update(body).digest('hex') }),
  secret: process.env.WEBHOOK_SECRET ?? 'test_secret_local',
  events: [
    {
      id: 'paid_1',
      type: 'payment.completed',
      body: { event: 'payment.completed', data: { reference: 'ref_1', amount: 5000 } },
    },
    {
      id: 'paid_2',
      type: 'payment.completed',
      body: { event: 'payment.completed', data: { reference: 'ref_2', amount: 1200 } },
    },
    {
      id: 'paid_3',
      type: 'payment.completed',
      body: { event: 'payment.completed', data: { reference: 'ref_3', amount: 800 } },
    },
  ],
  reset: '/hookstorm/reset',
  probe: '/hookstorm/state',
  sink: { port: 4401 },
  invariants: [
    custom('one ledger entry per payment', ({ state }) => {
      const count = new Map<string, number>();
      for (const row of state.ledger) count.set(row.reference, (count.get(row.reference) ?? 0) + 1);
      return [...count].filter(([, n]) => n > 1).map(([ref, n]) => `${ref} has ${n} ledger entries`);
    }),
    custom('every acknowledged payment is in the ledger', ({ events, isAcked, state }) =>
      events
        .filter((e) => isAcked(e.id))
        .map((e) => e.json.data.reference)
        .filter((ref) => !state.ledger.some((row: { reference: string }) => row.reference === ref))
        .map((ref) => `${ref} was acknowledged but never recorded`),
    ),
  ],
});

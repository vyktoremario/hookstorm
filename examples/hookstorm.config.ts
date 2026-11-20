import { atMostOnce, custom, defineConfig, exactlyOnce, finalState } from 'hookstorm-cli';

type Data = {
  reference?: string;
  transaction_reference?: string;
  amount: number;
  customer: { email: string };
};
const payload = (json: unknown) => json as { event: string; data: Data };
const refOf = (json: unknown) => payload(json).data.reference ?? payload(json).data.transaction_reference;

export default defineConfig({
  // Buggy receiver by default; pass --target http://127.0.0.1:3002/webhooks/paystack for the fixed one.
  target: 'http://127.0.0.1:3001/webhooks/paystack',
  provider: 'paystack',
  secret: process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_hookstorm_demo',
  events: './events/paystack-wallet.jsonl',
  profile: 'realistic',
  timeoutMs: 300,

  // The receivers send their side effects here. Some calls fail on purpose, like a flaky ledger or email API.
  sink: { port: 4400, faults: { 'wallet.credit': 0.1, 'wallet.debit': 0.3, 'email.receipt': 0.2 } },

  // Test-only routes on the receiver, resolved against the target's origin.
  reset: '/hookstorm/reset',
  probe: '/hookstorm/state',

  eventKey: (e) => refOf(e.json),

  invariants: [
    atMostOnce(
      'wallet.credit',
      (c) => c.body.reference,
      'each payment is credited to the wallet at most once',
    ),

    atMostOnce('email.receipt', (c) => c.body.reference, 'each payment sends at most one receipt'),

    exactlyOnce('wallet.debit', (c) => c.body.reference, {
      forEachEvent: 'refund.processed',
      eventKey: (e) => refOf(e.json),
      description: 'every acknowledged refund is debited exactly once',
    }),

    finalState('a refunded payment stays refunded', (state, obs) =>
      obs.events
        .filter((e) => e.type === 'refund.processed' && obs.isAcked(e.id))
        .map((e) => refOf(e.json)!)
        .filter((ref) => state.payments[ref]?.status !== 'refunded')
        .map((ref) => `${ref} ended as "${state.payments[ref]?.status}" after its refund was acknowledged`),
    ),

    custom('wallet balances match acknowledged payments and refunds', ({ events, isAcked, state }) => {
      const expected: Record<string, number> = {};
      const pending = new Set<string>(); // customers with events the provider is still retrying
      for (const e of events) {
        const { event, data } = payload(e.json);
        const who = data.customer.email;
        if (!isAcked(e.id)) pending.add(who);
        else
          expected[who] = (expected[who] ?? 0) + (event === 'refund.processed' ? -data.amount : data.amount);
      }
      const wallets = (state as { wallets: Record<string, number> }).wallets;
      return Object.entries(expected)
        .filter(([who, want]) => !pending.has(who) && (wallets[who] ?? 0) !== want)
        .map(([who, want]) => `${who}: balance ${wallets[who] ?? 0}, expected ${want}`);
    }),
  ],
});

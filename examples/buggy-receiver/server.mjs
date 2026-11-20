// A wallet top-up service, written the way webhook handlers often are: it passes manual testing and
// happy-path tests, and quietly breaks under retries, duplicates and reordering.
//
// Each BUG comment says what Hookstorm catches. Compare with ../fixed-receiver/server.mjs.
import { dbLatency, effect, serve, sleep } from '../shared.mjs';

let payments = {}; // reference -> { status, customer, amount }
let wallets = {}; // customer -> balance (kobo)
let seen = new Set(); // references already handled

async function handlePaystack(event, ack) {
  const data = event.data ?? {};

  if (event.event === 'charge.success') {
    const ref = data.reference;
    const customer = data.customer.email;

    // BUG 1: check-then-act. `seen` is only updated after several awaits, so a duplicate delivery that arrives
    // in the meantime (concurrent duplicate, or a provider retry after a timeout) passes the check too.
    // Caught by: atMostOnce('wallet.credit')
    if (seen.has(ref)) return { status: 200, body: 'duplicate' };

    await dbLatency();
    await effect('wallet.credit', { reference: ref, customer, amount: data.amount });
    wallets[customer] = (wallets[customer] ?? 0) + data.amount;

    // BUG 2: slow work before acknowledging. The provider gives up waiting, marks the delivery failed and
    // retries, while this request is still running. Caught by: atMostOnce('email.receipt'), and BUG 1 again.
    await sleep(400); // render PDF, call the email API, etc.
    await effect('email.receipt', { reference: ref, to: customer });

    // BUG 3: blind overwrite. If refund.processed was delivered first (reordering), the payment goes from
    // "refunded" back to "paid". Caught by: finalState('a refunded payment stays refunded')
    payments[ref] = { ...payments[ref], status: 'paid', customer, amount: data.amount };
    seen.add(ref);
    return { status: 200 };
  }

  if (event.event === 'refund.processed') {
    const ref = data.transaction_reference;
    const customer = data.customer?.email ?? payments[ref]?.customer;

    // BUG 5: no idempotency at all for refunds: duplicates and retries debit again.
    // BUG 4: acknowledge first, then do the work fire-and-forget, swallowing errors. When the ledger call
    // fails, the refund is lost for good: the provider got its 200 and will never retry.
    // Caught by: exactlyOnce('wallet.debit'), and the wallet balance invariant.
    ack(200);
    payments[ref] = { ...payments[ref], status: 'refunded' };
    effect('wallet.debit', { reference: ref, customer, amount: data.amount })
      .then(() => {
        wallets[customer] = (wallets[customer] ?? 0) - data.amount;
      })
      .catch(() => {});
    return;
  }

  return { status: 200, body: 'ignored' };
}

serve({
  port: Number(process.env.PORT ?? 3001),
  name: 'buggy-receiver',
  handlePaystack,
  snapshot: () => ({ payments, wallets }),
  reset: () => {
    payments = {};
    wallets = {};
    seen = new Set();
  },
});

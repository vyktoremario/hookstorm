// The same wallet top-up service, with the bugs fixed using standard webhook-receiver patterns.
// Each FIX comment names the bug it fixes in ../buggy-receiver/server.mjs.
//
// State is in memory to keep the demo dependency-free. With a real database the same ideas map to:
//   claim       -> INSERT INTO processed_events (key) ... ON CONFLICT DO NOTHING, in the same transaction as the work
//   outbox      -> an outbox table written in that transaction, drained by a worker
//   advance()   -> UPDATE payments SET status = $new WHERE ref = $ref AND rank(status) < rank($new)
import { dbLatency, effect, serve, sleep } from '../shared.mjs';

let payments = {};
let wallets = {};
let processed = new Set(); // idempotency keys whose work is done
let inflight = new Set(); // idempotency keys being worked on right now
let generation = 0; // bumps on reset so stale outbox jobs from a previous run are dropped

const RANK = { pending: 0, paid: 1, refunded: 2 };

// FIX 3: a state machine that only moves forward. A late "paid" can't overwrite "refunded".
function advance(ref, status, fields = {}) {
  const current = payments[ref]?.status ?? 'pending';
  payments[ref] = { ...payments[ref], ...fields };
  if (RANK[status] > RANK[current]) payments[ref].status = status;
}

// FIX 2: slow work (the receipt email) goes to an outbox and is sent after the webhook is acknowledged,
// with retries and its own idempotency key. The handler answers in milliseconds.
const outbox = [];
const sent = new Set();
function enqueue(key, name, body) {
  outbox.push({ key, name, body, gen: generation, tries: 0 });
  void drain();
}
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  while (outbox.length) {
    const job = outbox.shift();
    if (job.gen !== generation || sent.has(job.key)) continue;
    try {
      await effect(job.name, job.body);
      sent.add(job.key);
    } catch {
      if (++job.tries < 10) {
        await sleep(20 * job.tries);
        outbox.push(job);
      }
    }
  }
  draining = false;
}

/**
 * FIX 1 + FIX 4: claim the idempotency key synchronously (no await between check and claim, so two
 * concurrent deliveries can't both pass), do the work, and only then acknowledge. On failure, release
 * the claim and answer 500 so the provider retries. A duplicate arriving while the first is still running
 * gets 409, not 200: if the first attempt fails, the provider must still have a reason to retry.
 */
async function once(key, work) {
  if (processed.has(key)) return { status: 200, body: 'already processed' };
  if (inflight.has(key)) return { status: 409, body: 'in progress, retry later' };
  inflight.add(key);
  try {
    await work();
    processed.add(key);
    return { status: 200 };
  } catch (err) {
    return { status: 500, body: String(err.message) };
  } finally {
    inflight.delete(key);
  }
}

async function handlePaystack(event) {
  const data = event.data ?? {};

  if (event.event === 'charge.success') {
    const ref = data.reference;
    const customer = data.customer.email;
    return once(`charge:${ref}`, async () => {
      await dbLatency();
      await effect('wallet.credit', { reference: ref, customer, amount: data.amount });
      wallets[customer] = (wallets[customer] ?? 0) + data.amount;
      advance(ref, 'paid', { customer, amount: data.amount });
      enqueue(`receipt:${ref}`, 'email.receipt', { reference: ref, to: customer });
    });
  }

  if (event.event === 'refund.processed') {
    const ref = data.transaction_reference;
    const customer = data.customer?.email ?? payments[ref]?.customer;
    // FIX 4: no fire-and-forget. The debit happens before the 200; if it fails, we answer 500 and the
    // provider retries.
    return once(`refund:${ref}`, async () => {
      await dbLatency();
      await effect('wallet.debit', { reference: ref, customer, amount: data.amount });
      wallets[customer] = (wallets[customer] ?? 0) - data.amount;
      advance(ref, 'refunded', { customer });
    });
  }

  return { status: 200, body: 'ignored' };
}

serve({
  port: Number(process.env.PORT ?? 3002),
  name: 'fixed-receiver',
  handlePaystack,
  snapshot: () => ({ payments, wallets }),
  reset: () => {
    payments = {};
    wallets = {};
    processed = new Set();
    inflight = new Set();
    outbox.length = 0;
    sent.clear();
    generation++;
  },
});

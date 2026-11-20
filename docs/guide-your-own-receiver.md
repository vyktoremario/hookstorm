# Testing your own webhook receiver

This guide takes you from "I have a webhook endpoint" to "Hookstorm tells me what breaks under retries". It works for any provider, not just the ones with presets.

You need three things:

1. **Events** to send: a few real payloads from your provider.
2. **A way to see what your app did**: a state probe, a sink, or both.
3. **Invariants**: the business rules that must hold no matter how events are delivered.

Plan on 30–60 minutes the first time.

## 0. Install and scaffold

```bash
npm i -D hookstorm-cli
npx hookstorm init --provider custom --target http://localhost:3000/webhooks
```

Use `--provider stripe`, `paystack` or `github` if one of those is your provider. Otherwise use `custom`. `init` writes `hookstorm.config.ts` and `hookstorm.events.jsonl`, both commented, which you edit in the steps below.

## 1. Tell Hookstorm how your provider signs requests

Your receiver should verify signatures, and Hookstorm re-signs every attempt so that verification keeps working ([ADR-0005](adr/0005-resign-every-attempt-with-test-secret.md)).

**With a preset** (`stripe`, `paystack`, `github`), set `secret` to the test-mode secret your local app verifies with. For Stripe, that's the `whsec_…` printed by `stripe listen`.

**With `provider: 'custom'`**, write a `sign` function that returns the headers your receiver checks. Most providers use one of these patterns. Check the exact header name and algorithm in your provider's docs:

```ts
import { createHmac } from 'node:crypto';

// HMAC of the raw body, hex, in a header (the most common pattern)
sign: ({ body, secret }) => ({ 'x-signature': createHmac('sha256', secret).update(body).digest('hex') }),

// HMAC-SHA512 (Monnify-style)
sign: ({ body, secret }) => ({ 'monnify-signature': createHmac('sha512', secret).update(body).digest('hex') }),

// A shared "secret hash" sent as-is (Flutterwave-style)
sign: ({ secret }) => ({ 'verif-hash': secret }),

// Timestamped, Stripe-style: sign `${timestamp}.${body}`
sign: ({ body, secret, nowSec }) => ({
  'x-timestamp': String(nowSec),
  'x-signature': createHmac('sha256', secret).update(`${nowSec}.${body}`).digest('hex'),
}),

// Your receiver skips verification in test mode
sign: () => ({}),
```

`body` is the exact string Hookstorm sends, so sign it and don't re-serialise it. `nowSec` is the current Unix time for each attempt, so timestamp checks keep passing.

Then match the provider's **delivery rules**: how many attempts, and which status codes count as success. Gaps between attempts are compressed to milliseconds, because only the number and order of attempts matter for correctness.

```ts
maxAttempts: 5,                // the provider's retry count (1 if it never retries)
backoffMs: [50, 100, 200, 400] // compressed gaps between attempts
```

## 2. Get events

The events file is JSON Lines, one event per line. `body` can be an object, or a string if you need exact bytes:

```jsonl
{"id":"paid_1","type":"payment.completed","body":{"event":"payment.completed","data":{"reference":"ref_1","amount":5000}}}
{"id":"refund_1","type":"refund.completed","body":{"event":"refund.completed","data":{"reference":"ref_1","amount":5000}}}
```

- `id`: unique within the file.
- `type`: inferred from `body.type` or `body.event` if you leave it out.
- `headers`: optional extra headers sent with every attempt (not signatures).

A handful of events that interact is better than many unrelated ones: a payment and its refund, two updates to the same order, a top-up and a withdrawal.

Three ways to get them:

- **Copy** sample payloads from your provider's docs or your logs.
- **Record** real test-mode deliveries. Point the provider's test webhook URL at the recorder (via a tunnel such as ngrok or cloudflared if the provider can't reach your machine). It saves each body byte-for-byte and forwards the request to your app unchanged:
  ```bash
  npx hookstorm record --provider custom --port 4500 --forward http://localhost:3000/webhooks
  ```
- **Stripe**, with no tunnel needed:
  ```bash
  npx hookstorm record --provider stripe --port 4500 --forward http://localhost:3000/webhooks/stripe
  stripe listen --forward-to localhost:4500        # in a second terminal; prints your whsec_ secret
  stripe trigger payment_intent.succeeded          # in a third
  ```

## 3. Let Hookstorm see what your app did

Hookstorm can't read your database. It needs one of these:

### Option A: probe (least work, recommended to start)

Add two test-only routes to your app and mount them only when `NODE_ENV=test`. Your webhook handler doesn't change.

```ts
// Express example
if (process.env.NODE_ENV === 'test') {
  app.post('/hookstorm/reset', async (_req, res) => {
    await db.query('TRUNCATE ledger_entries, orders RESTART IDENTITY CASCADE');
    res.sendStatus(204);
  });
  app.get('/hookstorm/state', async (_req, res) => {
    res.json({
      ledger: (await db.query('SELECT reference, amount FROM ledger_entries')).rows,
      orders: (await db.query('SELECT id, status FROM orders')).rows,
    });
  });
}
```

```ts
reset: '/hookstorm/reset', // POST before each seed, so runs don't leak into each other
probe: '/hookstorm/state', // GET after each seed; available to invariants as `state`
```

The probe should return whatever your rules need to look at: rows, counts, balances. A full working example is [`examples/probe-only-receiver`](../examples/probe-only-receiver/server.mjs) with [`examples/probe-only.config.ts`](../examples/probe-only.config.ts).

### Option B: sink (when the handler calls other services)

If the important effects are calls to other services (charging a card, sending an email, calling a fulfilment API), make their base URL configurable and point it at the sink in tests:

```bash
PAYMENTS_API_URL=http://127.0.0.1:4400/sink/payments EMAIL_API_URL=http://127.0.0.1:4400/sink/email npm start
```

A call to `POST http://127.0.0.1:4400/sink/payments/charge` is recorded as effect `payments.charge` with its JSON body. The sink can also **fail calls on purpose**, to test your handler's own error handling:

```ts
sink: { port: 4400, faults: { 'payments.charge': 0.1, 'email.send': 0.3 } },
```

A failed call counts as not having happened. Each logical call fails at most twice in a row, so a correct retry strategy always gets through eventually.

The [demo receivers](../examples) use both options.

## 4. Write invariants

Write the rules your business already has. Some starting points:

| Rule                       | With the probe (`state`)                                            | With the sink                                                                          |
| -------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| No double charge or credit | `custom`: count `state.ledger` rows per reference                   | `atMostOnce('payments.charge', (c) => c.body.reference)`                               |
| No lost events             | `custom`: every acknowledged event's reference is in `state.ledger` | `exactlyOnce('payments.charge', key, { forEachEvent: 'payment.completed', eventKey })` |
| State never goes backwards | `finalState`: refunded orders are still `refunded`                  | `monotonic('order.status', ['pending', 'paid', 'shipped'], { key })`                   |
| Balances add up            | `custom`: compare balances with the acknowledged events             | n/a                                                                                    |

Inside `custom` and `finalState` you get:

- `state`: what the probe returned.
- `events`: your fixtures, each with `.json` (parsed body) and `.type`.
- `isAcked(eventId)`: whether the provider got a success response. Events the provider never got a success for are still being retried in real life, so don't expect their effects yet.
- `sink`: every recorded call (`effect`, `body`, `ok`).
- `deliveries` and `plan`: exactly what was sent, when, and with which fault.

```ts
custom('one ledger entry per payment', ({ state }) => {
  const count = new Map<string, number>();
  for (const row of state.ledger) count.set(row.reference, (count.get(row.reference) ?? 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([ref, n]) => `${ref} has ${n} ledger entries`);
}),
```

Return a list of messages, or an empty list or nothing when the rule holds.

## 5. Run it

Start your app, then run:

```bash
npx hookstorm run --runs 20
```

Each line is one seed. For each broken rule you get the first failing example, the timeline of deliveries and side effects behind it, and a command that replays that exact plan:

```text
✗ one ledger entry per payment
  violated 7× across 6/20 seed(s)
  ref_2 has 2 ledger entries  (seed 1834)
    reproduce: hookstorm run -c hookstorm.config.ts --target http://localhost:3000/webhooks --seed 1834 --runs 1
```

Useful flags:

- `--profile gentle|realistic|hostile`: how much chaos.
- `--timeout <ms>`: per-attempt response timeout. The default is 1000, stricter than real providers on purpose, to catch slow work done before the response.
- `--settle <ms>`: how long to wait for background work before reading state. The default is 500. Raise it if your app processes webhooks on a queue.

### What to do with a failure

1. Rerun the printed command. If it fails every time, it's an ordering or retry bug. If it fails only sometimes and the report says the plan had concurrent deliveries, it's a race.
2. Read the timeline: which attempt was dropped, timed out, or arrived out of order.
3. The usual fixes:
   - **Idempotency key** with an atomic insert (`INSERT … ON CONFLICT DO NOTHING`) in the same transaction as the work.
   - **Respond only after the work is committed**, and answer non-2xx if it failed so the provider retries.
   - **Move slow work** to a queue or outbox after the commit.
   - **A state machine** that only moves forward.

   [`examples/fixed-receiver`](../examples/fixed-receiver/server.mjs) shows each one.

## 6. Put it in CI

```yaml
- run: docker compose up -d db
- run: NODE_ENV=test npm start & npx wait-on http://localhost:3000/health
- run: npx hookstorm run --runs 25 --junit hookstorm.xml
```

The exit code is `1` when an invariant breaks and `2` when the config is wrong or the app can't be reached. JUnit output gives one test case per invariant per seed.

## Troubleshooting

- **Every attempt is `rejected 401`:** the signature doesn't match. Check that `secret` is the one your app verifies with, and that `sign` uses the same header and algorithm.
- **`could not reach …`:** the app isn't listening on `target`, or `target` points at the wrong port or path.
- **Rules fail even against a correct app:** the state was read too early (raise `--settle`), or `reset` doesn't clear everything the rule reads.
- **Port 4400 is in use:** set `sink: { port: … }` or pass `--sink-port`.

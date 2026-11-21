# Hookstorm

**Chaos-test your webhook _receivers_.** Hookstorm plays the webhook provider. It delivers your events with duplicates, reordering, delays, dropped requests, dropped responses and timeouts, retrying the way Stripe, Paystack or GitHub would. Then it checks your business rules ("each payment is credited at most once", "a refunded order stays refunded") and tells you which ones broke, with a seed that reproduces the failure.

[![CI](https://github.com/vyktoremario/hookstorm/actions/workflows/ci.yml/badge.svg)](https://github.com/vyktoremario/hookstorm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hookstorm-cli)](https://www.npmjs.com/package/hookstorm-cli)

Webhook providers promise **at-least-once, unordered** delivery. Most handlers are written and tested as if delivery were exactly-once and in order. The gap shows up in production as double charges, refunds overwritten by late "paid" events, and events lost because the handler said `200` before doing the work. Tools like Svix and Hookdeck make _sending_ webhooks reliable. Hookstorm tests whether your _receiver_ is correct when delivery isn't.

## 2-minute demo

The repo has a small wallet top-up service in two versions. [`examples/buggy-receiver`](examples/buggy-receiver/server.mjs) is written the way webhook handlers often are. [`examples/fixed-receiver`](examples/fixed-receiver/server.mjs) is the same service with standard fixes. Both receive Paystack-style `charge.success` and `refund.processed` events.

```bash
git clone https://github.com/vyktoremario/hookstorm && cd hookstorm
npm ci && npm run build
npm run demo
```

`npm run demo` starts both receivers and runs Hookstorm against each with the same 5 seeds. Abridged output:

```text
━━━ 1/2  buggy receiver ━━━
hookstorm v0.1.0 · paystack → http://127.0.0.1:3001/webhooks/paystack · profile realistic · 6 events · 5 seed(s) from 1

[1/5] seed 1  10 violation(s)  23 attempts: 1 dup, 1 concurrent, 1 dropped requests, 3 dropped responses, 8 timeouts
...
✗ each payment is credited to the wallet at most once
  violated 15× across 5/5 seed(s)
  wallet.credit happened 3× for ref_bola_1  (seed 1)
        0ms  deliver charge_bola_1#0 (charge.success) attempt 1 → rejected 500
        2ms  deliver charge_bola_1#1 (charge.success) attempt 1 → timed out waiting for the app
       13ms  side effect wallet.credit → 200
       75ms  deliver charge_bola_1#0 (charge.success) attempt 2 → timed out waiting for the app
       81ms  side effect wallet.credit → 200
      362ms  deliver charge_bola_1#1 (charge.success) attempt 2 → timed out waiting for the app
      373ms  side effect wallet.credit → 200
      436ms  deliver charge_bola_1#0 (charge.success) attempt 3 → acknowledged 200
    reproduce: hookstorm run -c examples/hookstorm.config.ts --target http://127.0.0.1:3001/webhooks/paystack --seed 1 --runs 1

✗ each payment sends at most one receipt
✗ every acknowledged refund is debited exactly once
✗ a refunded payment stays refunded
  ref_ada_1 ended as "paid" after its refund was acknowledged  (seed 1)
✗ wallet balances match acknowledged payments and refunds
  ada@example.com: balance 575000, expected 75000  (seed 1)

5 of 5 invariants violated in 5/5 seed(s)

━━━ 2/2  fixed receiver ━━━
[1/5] seed 1  pass  ...
✓ All 5 invariants held across 5 seed(s) (4.5s)

exit codes: buggy=1 (expected 1), fixed=0 (expected 0)
```

What was wrong, and how each fix maps to a rule:

| Bug in the buggy receiver                                                         | Fault that exposes it                         | Rule that catches it                  | Fix in the fixed receiver                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Check-then-act dedupe: `if (seen.has(ref))`, then several awaits, then `seen.add` | concurrent duplicates, retries after timeouts | credited at most once                 | Claim the key synchronously before any await; a duplicate seen mid-flight gets 409, not 200 |
| Slow work (receipt email) before the ack                                          | provider timeout, then retry                  | at most one receipt                   | Ack fast; send the receipt from an outbox with its own idempotency key                      |
| `status = 'paid'` overwrites whatever was there                                   | reordering (refund delivered before charge)   | refunded stays refunded               | Forward-only state machine                                                                  |
| Ack `200` first, then fire-and-forget the debit, swallowing errors                | a flaky downstream call (sink fault)          | refund debited exactly once; balances | Do the work, then ack; on failure answer 500 so the provider retries                        |
| No dedupe for refunds at all                                                      | duplicate delivery, dropped response          | refund debited exactly once           | Same idempotency claim as charges                                                           |

### On a real app

[hookstorm-playground](https://github.com/vyktoremario/hookstorm-playground) is a NestJS + Postgres ticket shop taking Stripe test-mode payments, with a careful-looking webhook handler (status check, transaction). Hookstorm, run against 14 real Stripe events, found two bugs: an order paid twice by concurrent duplicate deliveries, and a payment processed again after its refund. With the same recording and seeds, the failure rate went from 24/50 seeds (`realistic`) and 29/30 (`hostile`) before the fix to zero after, and 200 more hostile seeds also passed.

### Measured results (v0.1.0, MacBook, Node 22)

- Buggy receiver: **5 of 5 invariants violated in 5 of 5 seeds** (seeds 1–5, `realistic` profile), about 8 s.
- Fixed receiver: **all invariants held across 50 seeds** on `realistic` (42 s) and **30 seeds on `hostile`** (35 s).
- Both results are checked in CI by [`test/demo.integration.test.ts`](test/demo.integration.test.ts) and the `npm run demo:smoke` step, on Linux, macOS and Windows.

## How it works

```
events.jsonl ─► scenario engine ─► delivery simulator ─► signer ─► HTTP ──► your app
                (seeded plan)      (provider retries,    (re-signs            │ side effects
                                    timeouts, faults)     each attempt)       ▼
                                                                         Hookstorm sink  (POST /sink/<effect>)
invariants ◄── delivery log + sink log + state probe (GET /hookstorm/state) ◄──┘
```

1. **Events** come from a JSONL fixture: recorded from a provider's test mode with `hookstorm record`, or hand-written.
2. The **scenario engine** turns `(events, profile, seed)` into a delivery plan. It decides up front which events are duplicated (sequentially or concurrently), the order, delays, and which attempts lose the request, lose the response, or time out. Same seed, same plan.
3. The **delivery simulator** plays the plan as the provider would: its retry count, what counts as success (Paystack: only `200`), and a response timeout. Time is compressed: backoff takes milliseconds, not hours.
4. Each attempt is **re-signed** with your test secret over the exact recorded bytes, so your real signature verification runs unchanged.
5. Your app sends its side effects ("charge", "credit wallet", "send email") to the **sink** instead of the real services. Optionally it exposes a test-only **state probe**.
6. **Invariants** check the delivery log, the sink log and the final state. Violations come with a timeline and a reproduce command.

Design decisions are recorded in [docs/adr](docs/adr), and the full spec is in [docs/SPEC.md](docs/SPEC.md).

## Use it on your app

**Step-by-step guide: [Testing your own webhook receiver](docs/guide-your-own-receiver.md).** It covers any provider (including ones without a preset), recording events, the probe-only setup, and writing invariants.

```bash
npm i -D hookstorm-cli
npx hookstorm init --provider custom --target http://localhost:3000/webhooks   # or stripe | paystack | github
```

`init` creates `hookstorm.config.ts` and `hookstorm.events.jsonl`. Then:

1. **Match your provider's signature.** Use a preset, or write a `sign` function for `provider: 'custom'`. Use your **test-mode** secret, never a production one.
2. **Let Hookstorm see what your app did.** Either add two test-only routes (`POST /hookstorm/reset`, `GET /hookstorm/state`) and check the state, or point the app's outgoing calls at the sink (`http://127.0.0.1:4400/sink/<effect>`). The probe route needs no change to your handler. See [`examples/probe-only-receiver`](examples/probe-only-receiver/server.mjs).
3. **Write the invariants**, then run `npx hookstorm run`.

```ts
import {
  atMostOnce,
  custom,
  defineConfig,
  eventsTakeEffect,
  exactlyOnce,
  finalState,
  monotonic,
} from 'hookstorm-cli';

export default defineConfig({
  target: 'http://localhost:3000/webhooks/stripe',
  provider: 'stripe', // stripe | paystack | github | custom
  secret: process.env.STRIPE_WEBHOOK_SECRET, // TEST mode secret
  events: './hookstorm.events.jsonl',
  profile: 'realistic', // gentle | realistic | hostile | { extends: 'hostile', duplicate: 0.8 }
  reset: '/hookstorm/reset', // paths resolve against target's origin
  probe: '/hookstorm/state',
  ignoredEventTypes: ['payment_intent.created', 'charge.updated'], // delivered, but left out of timelines
  sink: { port: 4400, faults: { 'email.send': 0.2 } }, // make downstream calls flaky on purpose

  invariants: [
    atMostOnce('order.fulfil', (call) => call.body.orderId, 'each order ships at most once'),
    exactlyOnce('order.fulfil', (call) => call.body.orderId, {
      forEachEvent: 'payment_intent.succeeded',
      eventKey: (e) => e.json.data.object.metadata.order_id,
    }),
    eventsTakeEffect({
      forEachEvent: 'payment_intent.succeeded',
      eventKey: (e) => e.json.data.object.metadata.order_id,
      record: (state, id) => state.orders.find((o) => o.id === id), // catches events the app silently ignored
    }),
    monotonic('order.status', ['pending', 'paid', 'shipped', 'refunded'], { key: (c) => c.body.orderId }),
    finalState('refunded orders stay refunded', (state) => state.orders.ord_1.status === 'refunded'),
    custom('no fulfilment for failed payments', ({ sink }) =>
      sink
        .filter((c) => c.ok && c.effect === 'order.fulfil' && c.body.failed)
        .map((c) => `${c.body.orderId} shipped`),
    ),
  ],
});
```

### Invariant helpers

| Helper                                                 | Catches                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `atMostOnce(effect, key)`                              | double charge, double fulfilment, duplicate emails                                                                                   |
| `exactlyOnce(effect, key, { forEachEvent })`           | duplicates **and** lost events (acked, but the work never happened). Skips events the provider is still retrying                     |
| `monotonic(effect, order, { key })`                    | state moving backwards in the side-effect stream                                                                                     |
| `finalState(description, (state) => …)`                | wrong final state, read from your probe                                                                                              |
| `eventsTakeEffect({ forEachEvent, eventKey, record })` | events your app acknowledged but ignored, e.g. because `reset` didn't seed the record they refer to. Also works with a sink `effect` |
| `custom(name, (observations) => string[])`             | anything else: you get events, plan, delivery log, sink log and state                                                                |

Only sink calls that succeeded count. A call the sink failed on purpose didn't happen.

### Providers

| Preset     | Signature                                                             | Success      | Simulated attempts | Notes                                                                                             |
| ---------- | --------------------------------------------------------------------- | ------------ | ------------------ | ------------------------------------------------------------------------------------------------- |
| `stripe`   | `Stripe-Signature: t=…,v1=HMAC-SHA256(t.body)`, fresh `t` per attempt | any 2xx      | 5                  | Real: retries up to 3 days in live mode                                                           |
| `paystack` | `x-paystack-signature: HMAC-SHA512(body)`                             | **200 only** | 5                  | Real: every 3 min ×4, then hourly for 72 h; 30 s timeout. No event id: dedupe on `data.reference` |
| `github`   | `X-Hub-Signature-256: sha256=HMAC-SHA256(body)`                       | any 2xx      | 1                  | Real: **no automatic retries**, 10 s timeout. A dropped delivery is lost                          |
| `custom`   | your `sign({ body, secret, event, attempt, nowSec })`                 | any 2xx      | 5                  | Flutterwave, Monnify, Svix-style, in-house                                                        |

Stripe and GitHub signatures are tested against the official `stripe` SDK and `@octokit/webhooks-methods`. Sources for each provider's behaviour are cited in [`src/presets.ts`](src/presets.ts).

### Recording real events

```bash
npx hookstorm record --provider stripe --port 4500 --forward http://localhost:3000/webhooks/stripe
stripe listen --api-key "$STRIPE_SECRET_KEY" --forward-to localhost:4500 \
  --events payment_intent.succeeded,charge.refunded   # the types your app handles, plus any you want as noise
```

Current Stripe CLI versions need an `--events` list (or `--all-snapshot`). `--api-key` makes the CLI listen on the same Stripe account as your app's key. If they differ, no events arrive and nothing tells you why.

The recorder saves each body byte-for-byte, drops signature headers (replays are re-signed), skips Stripe `livemode: true` events, and forwards the original request unchanged, so your app keeps working while you record.

### CLI

```text
hookstorm run   [-c hookstorm.config.ts] [--target url] [--seed n] [--runs 10] [--repeat-seed 1] [--profile realistic]
                [--timeout ms] [--settle ms] [--sink-port 4400] [--json report.json] [--junit report.xml] [-q]
                [--env-file .env | --no-env-file] [--full-timeline]
hookstorm init  [--provider stripe|paystack|github|custom] [--target url]
hookstorm record --provider <name> [--port 4500] [--forward url] [-o hookstorm.events.jsonl]
```

Exit codes: `0` all invariants held, `1` violations found, `2` config error, target unreachable, or **inconclusive** (every run warned that the events had no visible effect, so nothing was really tested).

`--repeat-seed n` replays each seed's plan n times and reports how often each rule failed per seed. "Every run" means a deterministic ordering or retry bug, while "7/20 runs" means a race that depends on your app's timing.

`hookstorm run` loads `.env` next to the config by default, so `secret: process.env.…` matches what your app uses. Variables already set in the shell win.

### In CI

```yaml
- run: npm start & npx wait-on http://localhost:3000/health
- run: npx hookstorm run --runs 25 --junit hookstorm.xml
```

## Limits (v0.1)

- Hookstorm's own plan is fully reproducible from a seed. Your app's behaviour under concurrency may not be: a race found with one seed can be timing-dependent. The report says so when deliveries overlapped, and `--repeat-seed` measures how often it fails.
- Default response timeout is 1 s, much stricter than real providers (10–30 s), to surface slow work before the ack. Raise it with `--timeout` if that's not what you want to test.
- It sees side effects that go through the sink, and state that your probe exposes. Writes straight to your own database are only visible through the probe.
- Not yet: HTML report, test-case shrinking, inline live-proxy mode, more presets. See [SPEC §7](docs/SPEC.md).

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm run build && npm test
npm run demo
```

Requires Node ≥ 22.12. Tested on Linux, macOS and Windows. Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Releases: [docs/RELEASING.md](docs/RELEASING.md). MIT licensed.

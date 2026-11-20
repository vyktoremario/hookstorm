# Hookstorm v1 — Spec

Status: **Approved 2026-11-20; v0.1.0 implemented** (see §13 for changes made during the build) · Target: v1 in ~7 weeks part-time (~8–10 h/week)

## 1. Problem

Webhook providers guarantee _at-least-once, unordered_ delivery. Receivers are usually written and tested as if delivery were _exactly-once and in order_. The bugs that follow only show up in production under retries and network trouble: an order fulfilled twice, a wallet credited twice, an order that goes from `refunded` back to `paid`, an event silently lost because the handler threw after returning `200`.

Tools like Svix and Hookdeck make **sending** webhooks reliable. Almost nothing tests whether the **receiver** is correct when delivery is unreliable. Hookstorm does that.

## 2. Core use case

> "I have a webhook handler. Before I ship it, I want to hammer it with realistic delivery failures and get a clear list of which business rules broke, plus a seed that reproduces each one."

The developer:

1. Has a set of events. They record real ones from a provider's test mode (`hookstorm record`), write them by hand, or use the presets' sample fixtures.
2. Points the app's outbound side effects (e.g. "charge", "ship", "send email") at Hookstorm's **sink**, or exposes a read-only **state probe** endpoint. Most apps already read these URLs from env vars.
3. Writes **invariants** in `hookstorm.config.ts`, e.g. "each `reference` is credited at most once".
4. Runs `hookstorm run`. Hookstorm delivers the events with faults injected, simulates the provider's retries, then checks the invariants.
5. Gets a report listing each violation, the delivery timeline that caused it, and the seed. Exit code is non-zero, so it works in CI.

### Demo scenario (the 2-minute README demo)

A small "wallet top-up" service receives Paystack-style `charge.success` events, plus a Stripe-style order flow (`payment_intent.succeeded`, `charge.refunded`).

| Bug in `examples/buggy-receiver`                                                   | Fault that exposes it                               | Invariant that catches it                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| No idempotency: credits the wallet on every delivery                               | duplicate, plus dropped response leading to a retry | `atMostOnce('wallet.credit', by reference)`                        |
| Check-then-act race (`if (!seen) { await credit; seen.add }`)                      | concurrent duplicates                               | same as above                                                      |
| Applies events blindly, so a late `payment_intent.succeeded` overwrites `refunded` | reorder                                             | `finalState` (order must end `refunded`) / `monotonic` transitions |
| Does slow work before replying, so the provider times out and retries              | timeout                                             | `atMostOnce('email.receipt')`                                      |
| Returns `200` and then throws in a fire-and-forget promise, so the event is lost   | (always)                                            | `exactlyOnce('wallet.credit')`, which flags the missing credit     |

`examples/fixed-receiver` fixes each bug with the standard patterns: an idempotency key with an atomic insert, a fast `200` with async processing, a state machine that rejects backward transitions, and durable processing before the ack. The demo is two commands:

```bash
npm run demo   # starts both receivers; buggy → 5/5 invariants violated, exit 1; fixed → all green, exit 0
```

## 3. Architecture

```
 events.jsonl ──► ┌──────────────────────────── hookstorm run ─────────────────────────────┐
 (recorded/       │                                                                        │
  hand-written)   │  Scenario engine ──► Delivery simulator ──► Signer ──► HTTP ──────────────► Receiver app
                  │  (seeded plan:       (provider preset:      (preset    client               (your code)
                  │   dup/reorder/       attempts, timeouts,     re-signs)  (timeouts,              │
                  │   delay/drop/        backoff, what counts                aborts)                │ side effects
                  │   timeout/concurrent) as success)                                               ▼
                  │                                                         Sink server ◄───── POST /sink/:effect
                  │  Assertion layer ◄── delivery log + sink log + state probe (GET your /state)    │
                  │        │                                                                        │
                  │        ▼                                                                        │
                  │  Reporter: terminal · JSON · JUnit XML                                          │
                  └────────────────────────────────────────────────────────────────────────────────┘
```

Components (each a module with its own tests):

- **Event source**: loads `events.jsonl` with `{ id, provider, type, body, headers?, offsetMs? }`. `hookstorm record` captures live events into this format. It runs as a transparent forwarding endpoint: `stripe listen --forward-to localhost:4400`, or a tunnel URL for Paystack/GitHub.
- **Scenario engine**: turns `(events, faultProfile, seed)` into a deterministic **delivery plan**, a list of attempts with scheduled time, concurrency group and per-attempt fault. It is a pure function, so a seed always reproduces the same plan. See ADR-0004.
- **Delivery simulator**: plays the plan. It acts as the provider, using the preset's retry policy (max attempts, compressed backoff, timeout, which status codes count as success). It owns the request/response faults: response dropped after the app processed it, client-side timeout and abort, connection reset before send.
- **Signer**: provider presets re-sign every attempt with the user's **test** webhook secret. See ADR-0005.
- **Sink server**: tiny HTTP server (default `:4400`) that records every side-effect call `POST /sink/<effect>` with the body and a timestamp, and returns a configurable response.
- **Assertion layer**: runs invariants over the **observations**: the delivery log, the sink log, and an optional state snapshot from the app's probe URL.
- **Reporter**: groups violations, shows the minimal timeline for each (e.g. `evt_1 attempt#1 → 200 (response dropped) · evt_1 attempt#2 → 200 · wallet.credit ×2`), the seed, and a one-line rerun command.

Runs are **multi-iteration**: `--runs 20` tries 20 seeds (shrinking is a stretch goal). Between iterations Hookstorm calls an optional `reset` hook (`POST /hookstorm/reset` on the app, or a JS function) so state doesn't leak between runs.

## 4. Fault model (v1)

| Fault          | What happens                                                           | What it simulates                                               |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `duplicate`    | Same event delivered N times (sequential)                              | Provider at-least-once delivery                                 |
| `concurrent`   | Duplicates sent in parallel                                            | Retries racing a slow first attempt; multiple provider workers  |
| `reorder`      | Events shuffled within a window                                        | Unordered delivery                                              |
| `delay`        | Attempt held for a random duration                                     | Backlogs; late events                                           |
| `dropRequest`  | Attempt never reaches the app; provider sees failure and retries       | Network loss before the app                                     |
| `dropResponse` | App processes it, Hookstorm discards the response; provider retries    | Network loss after the app commits (the classic double-process) |
| `timeout`      | Hookstorm aborts after preset timeout; app may still be working; retry | Slow handlers                                                   |
| `error5xx`*    | Provider-side: treat as failure regardless                             | Load balancer flakiness                                         |

\* `error5xx` is a stretch goal.

Built-in profiles: `gentle`, `realistic` (default), `hostile`. Each is a set of probabilities that can be overridden in config.

## 5. Invariants: how users describe correctness

Invariants are code, in `hookstorm.config.ts`, with a small helper library for the common cases (ADR-0003):

```ts
import { defineConfig, atMostOnce, exactlyOnce, finalState, monotonic, custom } from 'hookstorm-cli';

export default defineConfig({
  target: 'http://localhost:3001/webhooks',
  provider: 'paystack',
  secret: process.env.PAYSTACK_TEST_SECRET,
  events: './events.jsonl',
  profile: 'realistic',
  reset: 'http://localhost:3001/hookstorm/reset',
  probe: 'http://localhost:3001/hookstorm/state',
  invariants: [
    atMostOnce(
      'wallet.credit',
      (call) => call.body.reference,
      'each payment reference is credited at most once',
    ),
    exactlyOnce('wallet.credit', (call) => call.body.reference, {
      forEachEvent: 'charge.success',
      eventKey: (e) => e.body.data.reference,
    }),
    finalState((state) => state.orders['ord_1'].status === 'refunded', 'refund is never overwritten'),
    monotonic('order.status', ['pending', 'paid', 'refunded'], (call) => call.body.orderId),
    custom('no credit for failed charges', ({ sink, events }) => /* return violations[] */ []),
  ],
});
```

- `atMostOnce` / `exactlyOnce` cover double charge, double fulfil and lost events.
- `monotonic` checks a sequence of sink calls never moves backward through an ordered list of states.
- `finalState` checks the probe snapshot after the run settles.
- `custom` gives full access to the observations for anything else.

The config is TS/JS, loaded with `jiti` so users don't need a build step. Plain `.js`/`.mjs` work too.

## 6. Provider presets (v1: Stripe, Paystack, GitHub)

A preset bundles: signing scheme, headers, event-id/idempotency hints, retry policy, timeout, and sample fixtures.

|                    | Stripe                                                               | Paystack                                                  | GitHub                                                         |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| Signature          | `Stripe-Signature: t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<raw body>")` | `x-paystack-signature: HMAC-SHA512(secret key, raw body)` | `X-Hub-Signature-256: sha256=HMAC-SHA256(secret, raw body)`    |
| Natural dedupe key | `event.id` (body)                                                    | none at event level; use `data.reference` / `data.id`     | `X-GitHub-Delivery` header (reused on redelivery)              |
| Retries            | yes, exponential backoff over days (compressed)                      | yes, over ~72 h (compressed)                              | **no automatic retries**, so a dropped delivery is simply lost |
| Real timeout       | not documented ("timed out" is a listed failure)                     | 30 s                                                      | 10 s                                                           |

The exact retry/timeout defaults are checked against each provider's current docs during the build and cited in `src/presets.ts`. In the simulator, time is always **compressed** (backoff collapsed to 50–400 ms; response timeout defaults to 1 s, deliberately stricter than production) because only attempt count and ordering matter for correctness.

**Re-signing concerns** (details in ADR-0005):

- Every attempt is re-signed at send time. Stripe retries carry a fresh timestamp too, so this matches production, and delayed events don't fail the receiver's 5-minute tolerance check by accident.
- Hookstorm **never needs a production secret**. Users pass their test-mode secret (or any string the app is configured with locally). The README says plainly not to point it at prod.
- The raw body bytes are signed and sent exactly as recorded. No JSON re-serialisation, because that is a classic source of signature mismatch.
- Optional fault `staleSignature`/`badSignature` (stretch) checks that the app _rejects_ forged or replayed requests.
- `custom` provider: users provide `sign(body, secret) => headers` for anything else (Flutterwave, Monnify, Svix-style).

## 7. Scope for v1

**In:** CLI (`init`, `run`, `record`), three presets plus `custom`, the fault model above, the invariant helpers, terminal/JSON/JUnit reporters, multi-seed runs, the demo apps, a GitHub Action usage example in the README, npm package.

**Out (v1.1+):** web dashboard (an HTML report is the first step), test-case shrinking, inline live-proxy mode (ADR-0001), Docker image, more presets (Flutterwave, Monnify, Shopify, Svix), stateful protocol fuzzing of payload fields.

**CLI vs dashboard:** CLI only. The target user runs it locally and in CI, where a non-zero exit code and JUnit output matter more than UI. A static HTML report (`--report html`) is the planned v1.1 step toward a dashboard.

## 8. Sample apps

- `examples/buggy-receiver`: Node + `node:http` (no framework, so it's readable), in-memory store with artificial async latency so races are real. It has the five bugs in §2.
- `examples/fixed-receiver`: same API, with each fix commented and linked to the invariant it satisfies.
- Both expose `/webhooks/paystack`, `/webhooks/stripe`, `/hookstorm/reset`, `/hookstorm/state` and call the sink for side effects.
- `examples/hookstorm.config.ts` + `examples/events/*.jsonl`.

## 9. Testing strategy

- **Unit (vitest):** seeded PRNG and plan generation (same seed gives the same plan; profiles respect probabilities within tolerance); each signer checked against the provider's official verifier (`stripe` SDK, `@octokit/webhooks-methods`) as dev dependencies, and against Paystack's documented algorithm with fixed vectors; each invariant helper against hand-built observation logs.
- **Integration:** start the sink and the example receivers in-process on ephemeral ports. Assert that the **buggy receiver fails with exactly the expected violation kinds** across a fixed set of seeds, and the **fixed receiver passes across 50 seeds**. This is Hookstorm's own regression suite and doubles as proof that the demo works.
- **Simulator behaviour:** a fake receiver with scripted latency/status asserts retries, timeouts, aborts and dropped responses happen as planned.
- **CLI e2e:** run the built `dist/cli.js` against the examples; check exit codes and JSON report shape.
- **CI (GitHub Actions):** Node 22 and 24 on ubuntu, plus Node 24 on macOS and Windows: lint (eslint + prettier check), typecheck, test, build, demo smoke test, `npm pack --dry-run`. Releases are automated with release-please (Conventional Commit PR titles → release PR → tag), publishing with npm trusted publishing (OIDC, provenance included). See `docs/RELEASING.md`.

## 10. Distribution

- npm package `hookstorm-cli` (`hookstorm` is taken on npm by an unrelated React hooks library). ESM, Node ≥ 22.12, `bin: hookstorm`, types exported for `defineConfig`.
- Built with `tsup`. Runtime deps kept minimal: `commander`, `picocolors`, `jiti`.
- MIT license. `CHANGELOG.md`, semver, `0.x` until the config API settles.

## 11. Plan (~7 weeks part-time)

| Week | Deliverable                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------- |
| 1    | Repo scaffold, CI, PRNG + scenario engine + tests                                               |
| 2    | Delivery simulator (retries, timeouts, dropped responses), sink server                          |
| 3    | Presets + signers verified against official SDKs; `custom` provider                             |
| 4    | Invariant helpers, probe/reset, assertion layer, reporters                                      |
| 5    | CLI (`init`, `run`, `record`), config loading                                                   |
| 6    | Buggy/fixed example apps, integration suite, README demo                                        |
| 7    | Polish, docs, ADR updates, measured results (bugs found per seed count, run time), release prep |

## 12. Success criteria for v1

- The README demo works from a fresh clone in under 2 minutes: the buggy receiver reports ≥ 4 distinct violations, the fixed receiver passes 50 seeds.
- Every reported violation includes a seed that reproduces it deterministically.
- Signatures verify with the official Stripe and GitHub verification libraries.
- CI is green; `npm pack` produces a working CLI.

## 13. Changes made during the build

- **Package name:** `hookstorm-cli`. The command is still `hookstorm`, and configs import from `'hookstorm-cli'`.
- **Node ≥ 22.12:** Node 20 reached end of life in April 2026, and current `commander`/`vitest`/`tsup` require 22.12 or later. CI runs Node 22 and 24, plus macOS.
- **Provider facts verified and cited** in `src/presets.ts`: Stripe retries up to 3 days in live mode (3 attempts in sandbox); Paystack retries every 3 min ×4 then hourly for 72 h, treats **only 200** as success, and times out at 30 s; GitHub never retries automatically and times out at 10 s.
- **`reset`/`probe` accept paths** (`'/hookstorm/state'`) resolved against the target's origin, so `--target` moves them too.
- **The sink can inject failures** (`sink.faults`), deterministic per (seed, effect, body, occurrence), and never more than `maxConsecutive` (default 2) times in a row for the same call. This was needed to show the "acked, then lost" bug, and the 3 → 5 attempt retry path in the fixed receiver.
- **`exactlyOnce` skips events the provider never got a success for**, since a real provider would still be retrying them. These are not receiver bugs.
- **The demo uses one provider (Paystack)** with charges and refunds, and covers 5 invariants including a `custom` wallet-balance check. Stripe and GitHub are covered by signer tests against their official verification libraries, and by `hookstorm init` templates.

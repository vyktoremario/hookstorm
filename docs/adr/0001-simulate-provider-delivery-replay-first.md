# ADR-0001: Simulate provider delivery (replay-first) instead of an inline live proxy

- Status: Proposed
- Date: 2026-11-20

## Context

The obvious design is a man-in-the-middle proxy: the provider sends to Hookstorm, and Hookstorm forwards to the app while injecting faults. To trigger retries, the proxy would drop or delay the app's response to the *real* provider.

That has serious problems:

- **Slow and non-deterministic.** Real retry schedules run from minutes to days (Stripe, Paystack), and GitHub doesn't retry at all. A test run would take hours and could not be reproduced.
- **Provider-side side effects.** Failing real deliveries can disable endpoints or send alert emails to the account owner.
- **Not CI-friendly.** CI has no public URL and no provider account.

## Decision

Hookstorm **plays the provider itself**. Events come from a JSONL fixture: recorded from a provider's test mode with `hookstorm record`, hand-written, or taken from preset samples. A delivery simulator applies the preset's retry policy with **compressed time**, signs each attempt, and sends it to the app.

`hookstorm record` is the only part that touches a real provider. It is a transparent forwarder that saves events while passing them through unchanged.

## Consequences

- Runs take seconds, are reproducible (ADR-0004), and need no network or account. That makes them suitable for CI.
- Hookstorm must model each provider's delivery semantics correctly (attempts, timeouts, success codes). Presets have to cite their sources and be kept up to date.
- Hookstorm can't catch bugs that depend on the provider's exact real timing. This is accepted, because correctness bugs depend on *ordering and multiplicity*, not wall-clock time.
- An inline live-proxy mode stays possible later (v1.1+) by reusing the scenario engine and signers.

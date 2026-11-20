# ADR-0002: Observe the app through a side-effect sink and a state probe

- Status: Proposed
- Date: 2026-11-20

## Context

To say "the customer was charged twice", Hookstorm has to see what the app *did*, not just what HTTP status it returned. Options:

1. **Read the app's database.** This couples Hookstorm to the schema and DB engine, and needs credentials.
2. **Instrument the app** with an SDK/agent (monkey-patching fetch, ORM hooks). This is invasive, language-specific and brittle.
3. **Sink:** the app already sends side effects to configurable URLs (payment API, fulfilment, email). In tests those URLs point at Hookstorm's sink, which records every call.
4. **Probe:** the app exposes a read-only, test-only `GET /hookstorm/state` returning a JSON snapshot. Hookstorm reads it after the run settles.

## Decision

Support **sink (primary) and probe (optional)**, both over plain HTTP. Also an optional `reset` endpoint or function for isolation between runs.

## Consequences

- Works with any language or framework. The only requirement is HTTP plus env-configurable URLs, which most apps have for their downstream calls anyway.
- Sink calls are timestamped and tied to deliveries through timing, plus an optional `x-hookstorm-event` correlation header the app may forward. Without correlation, invariants key on business fields (e.g. `reference`), which is what matters anyway.
- Side effects that go straight to the app's own DB (e.g. `UPDATE wallet`) are only visible through the probe. The docs give a pattern for exposing them.
- A small amount of test-only code is needed in the app (probe/reset routes, gated behind an env flag). The examples show how.

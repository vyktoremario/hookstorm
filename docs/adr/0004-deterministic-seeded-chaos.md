# ADR-0004: Chaos is planned up front from a seed

- Status: Proposed
- Date: 2026-11-20

## Context

A chaos tool that finds a bug but can't reproduce it is of little use. `Math.random()` decisions made during delivery depend on network timing, so the same run can't be repeated.

## Decision

- A seeded PRNG (small, dependency-free, e.g. mulberry32/sfc32) drives a **pure** scenario function: `(events, profile, seed) → DeliveryPlan`.
- The plan is fully decided before any request is sent: which events are duplicated, the order, delays, and which attempts get their response dropped or time out.
- Every report prints the seed and a rerun command. `--runs N` tries N seeds, starting from `--seed` or a random one.
- The plan is saved in the JSON report, so a failure can be inspected without re-running.

## Consequences

- Hookstorm's own behaviour is exactly reproducible. The *app's* behaviour under concurrency may not be: a race found with seed 42 may only show up on some runs. The report says so honestly (e.g. "concurrent fault involved: may be timing-dependent"), and `--repeat-seed K` reruns a seed several times to measure how often it fails.
- Unit-testing the scenario engine is simple: it's a pure function.
- Shrinking (finding the smallest failing plan) becomes possible later because plans are data.

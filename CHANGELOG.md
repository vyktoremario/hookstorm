# Changelog

## 0.1.0 (2026-11-20)

First release.

- `hookstorm run`: seeded fault plans (duplicate, concurrent duplicate, reorder, delay, dropped request, dropped response, timeout), provider retry simulation, sink with injectable failures, state probe/reset hooks, invariant checks, terminal/JSON/JUnit reports.
- Invariant helpers: `atMostOnce`, `exactlyOnce`, `monotonic`, `finalState`, `custom`.
- Presets: `stripe`, `paystack`, `github`, `custom`.
- `hookstorm init` and `hookstorm record`.
- Demo: buggy and fixed wallet receivers.
- `hookstorm init --provider custom`: scaffold for providers without a preset, with signing patterns. Every template now also shows the probe-only setup.
- `hookstorm run` checks the target is reachable before starting and exits with code 2 and a clear message if it isn't.
- Guide: [Testing your own webhook receiver](docs/guide-your-own-receiver.md), plus a probe-only example receiver.
- `Observations.state` is typed loosely (`any`), like sink call bodies, so invariants can read it without casts.

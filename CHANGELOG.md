# Changelog

## Unreleased

- `hookstorm init --provider custom`: scaffold for providers without a preset, with signing patterns. Every template now also shows the probe-only setup.
- `hookstorm run` checks the target is reachable before starting and exits with code 2 and a clear message if it isn't.
- Guide: [Testing your own webhook receiver](docs/guide-your-own-receiver.md), plus a probe-only example receiver.
- CI runs on Windows; the demo script is now Node (`npm run demo`) instead of bash.
- The release workflow uses npm trusted publishing (OIDC) instead of an `NPM_TOKEN` secret.
- `Observations.state` is typed loosely (`any`), like sink call bodies, so invariants can read it without casts.

## 0.1.0 (unreleased)

First release.

- `hookstorm run`: seeded fault plans (duplicate, concurrent duplicate, reorder, delay, dropped request, dropped response, timeout), provider retry simulation, sink with injectable failures, state probe/reset hooks, invariant checks, terminal/JSON/JUnit reports.
- Invariant helpers: `atMostOnce`, `exactlyOnce`, `monotonic`, `finalState`, `custom`.
- Presets: `stripe`, `paystack`, `github`, `custom`.
- `hookstorm init` and `hookstorm record`.
- Demo: buggy and fixed wallet receivers.

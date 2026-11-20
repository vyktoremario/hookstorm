# Changelog

## 0.1.0 (unreleased)

First release.

- `hookstorm run`: seeded fault plans (duplicate, concurrent duplicate, reorder, delay, dropped request, dropped response, timeout), provider retry simulation, sink with injectable failures, state probe/reset hooks, invariant checks, terminal/JSON/JUnit reports.
- Invariant helpers: `atMostOnce`, `exactlyOnce`, `monotonic`, `finalState`, `custom`.
- Presets: `stripe`, `paystack`, `github`, `custom`.
- `hookstorm init` and `hookstorm record`.
- Demo: buggy and fixed wallet receivers.

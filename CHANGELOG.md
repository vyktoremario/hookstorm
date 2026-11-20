# Changelog

## [0.2.0](https://github.com/vyktoremario/hookstorm/compare/v0.1.1...v0.2.0) (2026-11-20)


### Features

* add --repeat-seed to tell deterministic failures from races, with per-seed failure rates ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))
* add ignoredEventTypes and --full-timeline to keep violation timelines focused ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))
* add the eventsTakeEffect rule, which flags acknowledged events that changed nothing, and expose the post-reset state to rules as baseline ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))
* hookstorm record prints a troubleshooting hint when no events arrive ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))
* load .env next to the config by default, with --env-file and --no-env-file ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))
* reject unknown config keys, with a did-you-mean suggestion ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))
* warn when replayed events have no visible effect, and report the run as inconclusive (exit code 2) instead of passing ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))


### Bug Fixes

* npm run demo picks free ports instead of failing when 3001, 3002 or 4400 is taken ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))
* only show the race note when two deliveries of the same event actually overlapped ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))


### Documentation

* cover seeding replayed records, keeping probe output to business data, and current stripe listen flags (--events, --api-key) ([bf51046](https://github.com/vyktoremario/hookstorm/commit/bf51046bbaa608ce1639f618bc0eaa3980526790))

## [0.1.1](https://github.com/vyktoremario/hookstorm/compare/v0.1.0...v0.1.1) (2026-11-20)


### Bug Fixes

* normalise the bin path so npm no longer rewrites it on publish ([b62f741](https://github.com/vyktoremario/hookstorm/commit/b62f74160513700adde803bb8acffc6583b02a48))


### Documentation

* add an npm version badge to the README ([b62f741](https://github.com/vyktoremario/hookstorm/commit/b62f74160513700adde803bb8acffc6583b02a48))

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

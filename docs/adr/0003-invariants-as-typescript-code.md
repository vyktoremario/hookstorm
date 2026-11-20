# ADR-0003: Invariants are TypeScript code with helper functions, not a YAML DSL

- Status: Accepted (2026-11-20)
- Date: 2026-11-20

## Context

Users must state business rules such as "each payment reference credited at most once" or "an order never goes from refunded back to paid". Options:

- **YAML/JSON DSL.** Readable and language-neutral, but each new kind of rule needs new DSL syntax, and extracting a key from a nested payload ends up as an expression language (JSONPath, JMESPath) bolted on.
- **Code (TS/JS config).** Fully expressive and type-checked. The target audience (Node/TS backend developers) already writes config this way (Vite, Vitest, Playwright).

## Decision

`hookstorm.config.ts` exports `defineConfig({...})`. Invariants are values built with helpers: `atMostOnce`, `exactlyOnce`, `monotonic`, `finalState`, plus `custom(name, fn)` that receives all observations and returns violations. Key extraction is a plain function. Config loads through `jiti`, so there's no build step.

## Consequences

- Common rules are one line each. Unusual rules don't need features from Hookstorm.
- Type definitions for observations (delivery log, sink calls, probe snapshot) are part of the public API and need semver care.
- Non-JS teams must write a small JS config. That's acceptable for v1, since the tool is distributed via npm. A declarative subset (YAML mapping onto the same helpers) can be added later without breaking the code API.
- Arbitrary user code runs in-process. That's fine for a local/CI developer tool and is documented.

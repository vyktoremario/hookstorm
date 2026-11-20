# Contributing

Thanks for helping. Issues and PRs are welcome.

## Setup

```bash
npm ci
npm run lint && npm run typecheck && npm run build && npm test
npm run demo          # buggy receiver fails, fixed receiver passes
```

Requires Node ≥ 22.12. CI runs on Linux (Node 22 and 24), macOS and Windows.

## Pull requests

- **Title:** follow [Conventional Commits](https://www.conventionalcommits.org/), e.g. `fix: handle empty request bodies` or `feat: add a Flutterwave preset`. PRs are squash-merged, so the title becomes the commit message, and it decides the next version and the changelog entry. A CI check validates it. See [docs/RELEASING.md](docs/RELEASING.md).
- **Tests:** add or update tests for behaviour changes. Signer changes should be checked against the provider's official verification library, or an independently computed vector.
- **Design changes:** a change to a decision recorded in [docs/adr](docs/adr) should add a new ADR or update the existing one.
- **Demo:** keep `npm run demo` passing. The buggy receiver must still fail and the fixed one must still pass.

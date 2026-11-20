# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please-action) and published to npm as [`hookstorm-cli`](https://www.npmjs.com/package/hookstorm-cli) by [`.github/workflows/release.yml`](../.github/workflows/release.yml), using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). No npm token is stored in this repository, and every release gets a provenance attestation.

## How a release happens

1. **Merge PRs as usual.** PR titles follow [Conventional Commits](https://www.conventionalcommits.org/), and a CI check enforces this. Squash merges use the PR title as the commit message, and that message decides the version:

   | PR title                                                 | Release                             |
   | -------------------------------------------------------- | ----------------------------------- |
   | `fix: handle empty request bodies`                       | patch (0.1.1)                       |
   | `feat: add a Flutterwave preset`                         | minor (0.2.0)                       |
   | `feat!: rename sink.faults` / `BREAKING CHANGE:` footer  | minor while `0.x`, major from `1.0` |
   | `docs: …`, `chore: …`, `ci: …`, `test: …`, `refactor: …` | none on its own                     |

2. **release-please keeps a release PR open,** titled `chore: release x.y.z`. On every push to `main` it updates that PR with the version bump in `package.json`, `package-lock.json` and `.release-please-manifest.json`, plus the changelog entries generated from the merged PR titles.

3. **When you want to ship, merge the release PR.** The release workflow then:
   - tags `vX.Y.Z` and creates a GitHub Release with the changelog;
   - checks out that tag, checks the version matches, runs lint, typecheck, build and tests;
   - publishes to npm from the `npm` GitHub environment.

Nothing else needs bumping. The CLI reads its version from `package.json` at runtime.

### CI on the release PR

GitHub doesn't run workflows for PRs opened with the default Actions token. That means the required checks never start on the release PR by themselves, and the `main` ruleset blocks the merge. Two ways around it:

- **Quick:** close and reopen the release PR. A PR you reopen triggers CI normally.
- **Permanent:** create a token release-please uses instead, and store it as the `RELEASE_PLEASE_TOKEN` repository secret. Either:
  - a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new), limited to this repository, with **Contents: read and write** and **Pull requests: read and write**; or
  - a GitHub App token, which is better for organisations.

  The workflow picks the secret up automatically.

## One-time setup (already done for `hookstorm-cli`)

1. The first version (0.1.0) was published by hand with `npm publish --access public`, because trusted publishing is configured on an existing package.
2. On npmjs.com → `hookstorm-cli` → **Settings** → **Trusted publishing** → **GitHub Actions**:
   - user `vyktoremario`, repository `hookstorm`
   - workflow `release.yml`, environment `npm`
   - **Allow `npm publish`** ticked
3. **Publishing access** is set to "Require two-factor authentication and disallow bypass 2fa tokens".
4. GitHub creates the `npm` environment the first time the publish job runs. To approve every publish yourself, add yourself as a required reviewer under **Settings** → **Environments** → **npm**.

A new trusted-publisher configuration expires 48 hours after it's created if no publish has used it. If it expires, re-create it with the same values.

## Publishing by hand (fallback)

If the workflow can't publish (for example the trusted publisher expired), publish from an up-to-date `main` at the release tag:

```bash
git switch main && git pull
git checkout vX.Y.Z
npm ci && npm run build && npm test
npm publish --access public
git switch main
```

# Releasing

Releases are published to npm as [`hookstorm-cli`](https://www.npmjs.com/package/hookstorm-cli) by the [release workflow](../.github/workflows/release.yml) when a `v*` tag is pushed. It uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): GitHub Actions proves its identity to npm with a short-lived OIDC token, so no npm token is stored in this repository, and every release gets a provenance attestation.

## One-time setup

Trusted publishing is configured from the package's settings on npmjs.com, so the package has to exist first.

1. Create an npm account and turn on two-factor authentication.
2. Publish the first version by hand, from an up-to-date `main`:
   ```bash
   npm view hookstorm-cli version            # an E404 error means the name is still free
   npm ci && npm run build && npm test
   npm login
   npm publish --access public
   ```
3. On npmjs.com, open the `hookstorm-cli` package → **Settings** → **Trusted publishing** → **GitHub Actions**, and enter:
   - Organization or user: `vyktoremario`
   - Repository: `hookstorm`
   - Workflow filename: `release.yml`
   - Environment: `npm`
4. In the GitHub repo, go to **Settings** → **Environments** → **New environment** and create one named `npm`. Optionally add yourself as a required reviewer, so every publish waits for your approval.
5. A new trusted publisher configuration expires after 48 hours if no publish validates it, so release the next version soon after setting it up. If it does expire, re-create it.
6. Once the workflow has published successfully, you can set the package's **Publishing access** to "Require two-factor authentication and disallow tokens" on npmjs.com.

## Every release

`main` is protected, so version bumps go through a pull request:

1. On a branch, update the version in **`package.json`**, **`package-lock.json`** and **`src/version.ts`**, and add a section to `CHANGELOG.md`:
   ```bash
   npm version 0.2.0 --no-git-tag-version   # updates package.json and package-lock.json
   ```
   Then edit `src/version.ts` and `CHANGELOG.md` by hand. A test fails if `src/version.ts` and `package.json` disagree.
2. Open a PR, wait for CI, and squash-merge it.
3. Tag the merge commit on `main` and push the tag:
   ```bash
   git switch main && git pull
   git tag v0.2.0 && git push origin v0.2.0
   ```
4. The release workflow checks that the tag, `package.json` and `src/version.ts` agree, runs the checks, and publishes. Approve the `npm` environment deployment if you set up a reviewer.

`0.x` versions may change the config API in minor releases. Note any such change in the changelog.

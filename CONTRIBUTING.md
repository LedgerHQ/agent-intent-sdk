# Contributing to Agent Intent SDK

This repository contains the headless `@ledgerhq/agent-intent-sdk` package.
Keep it independent from frontend frameworks, browser storage, Ledger device
SDKs, application state, and development-only mocks.

## Get started

1. Create a branch from `main`.
2. Run `mise install`.
3. Run `pnpm install`.
4. Run `pnpm verify` before opening a pull request.

## Branches and commits

Use `feat/`, `fix/`, `support/`, or `chore/` branch prefixes. Commit messages and
pull-request titles follow
[Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(enrollment): add a new enrollment source
```

Open pull requests against `main`. Keep changes focused and include tests for
protocol encoding, validation, authentication, or public API changes.

## Required checks

`pnpm verify` runs the same core gate as CI:

- formatting
- linting
- type checking
- unit tests
- package build
- tarball content and clean-consumer import checks

Do not merge code that relies on TypeScript source exports. Published entry
points must resolve to compiled JavaScript and declarations under `dist/`.

## Changesets

Run `pnpm changelog` for every user-visible behavior or public API change and
commit the generated `.changeset/*.md` file.

- `patch`: compatible bug fixes
- `minor`: compatible features and new APIs
- `major`: breaking changes

The package is currently unstable, but changesets still document impact and
drive every release. Documentation-only, test-only, and tooling-only changes do
not need a changeset.

## Pull-request checklist

- Tests cover the change and failure cases.
- `pnpm verify` passes.
- A changeset is included when required.
- No secrets, credentials, private keys, access tokens, or production user data
  are committed.
- Protocol and wire-format changes are checked against the Agent Intent service
  contract.

## Releases

Releases are automated; do not run `changeset version` or `changeset publish`
locally.

1. Merge a pull request with a changeset into `main`.
2. The release workflow opens or updates `chore(release): version package`.
3. Review and merge that version pull request into `main`.
4. The same workflow builds, verifies, and publishes the version to Ledger
   JFrog, then creates the package tag and GitHub release.

`main` is the only long-lived branch. Version tags are the immutable release
history; there is no release-promotion branch.

Repository maintainers must configure the GitHub App credentials and JFrog
variables listed in [docs/RELEASE.md](./docs/RELEASE.md).

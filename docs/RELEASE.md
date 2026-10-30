# Release process

The repository follows the single-branch Changesets model used by
`LedgerHQ/wallet-api`. `main` is the only long-lived branch, and version tags
are the immutable release history.

## Required repository configuration

### Secrets

- `CI_BOT_TOKEN`: organization secret. It opens the version pull request, so
  that CI runs on it, and pushes release tags and GitHub releases.

### Repository variables

- `RELEASE_RUNNER`: optional runner override; defaults to
  `public-ledgerhq-shared-medium`. It must be a GitHub-hosted runner
  (attestation requirement) with an IP allowlisted by JFrog.
- `ARTIFACTORY_PUBLISH_URL`: JFrog npm publish registry

Publishing uses JFrog OIDC; do not configure a long-lived npm token. The JFrog
`github-oidc` provider must also authorize OIDC subjects from
`LedgerHQ/agent-intent-sdk`, with write access on the publish registry
(`LedgerHQ/tf-jfrog`). `ledgerlive-npm-prod-public` forwards published versions
to npmjs.com.

### Visibility

The attestation step only runs on a public repository: its signatures go to the
public Sigstore transparency log.

## Flow

1. A push to `main` with pending changesets updates the version pull request.
2. Merging the version pull request consumes changesets, updates the version,
   and writes `CHANGELOG.md`.
3. The resulting push to `main` has no pending changesets, so the same
   workflow checks against the JFrog publish registry whether the current
   version is missing. If it is, the workflow verifies the package, packs it,
   attests the tarball with SLSA provenance and publishes that exact tarball.
   It then creates the tag and GitHub release if they are missing.

Changesets tags this single-package repository as `v<version>`.

## Recovery

- If the version pull request has no CI run, verify that `CI_BOT_TOKEN` is
  available to the repository; pull requests created by `GITHUB_TOKEN` do not
  trigger workflows.
- If publishing partially succeeds, re-run the failed `Release` run (do not
  dispatch a new one). The publish plan leaves out a version already present in
  JFrog, and the version is still tagged and released if it was not. The tag is
  created on the commit the run was triggered on, so a version that is
  published but not tagged is only tagged from the commit that set it. Until
  then, the publish job of a later push to `main` or of a new dispatch fails
  instead of tagging a newer commit.
- If the publish registry variable is absent, the workflow stops before
  publishing so it cannot accidentally target the read registry.

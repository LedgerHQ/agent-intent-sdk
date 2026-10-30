#!/usr/bin/env bash
# Publish script for changesets/action/publish in release.yml.
#
# 1. Publishes the attested tarball in PACK_DIR, if one was packed.
# 2. Tags the package if its current version has no git tag yet.
# 3. Reports the current tag again if it was pushed but has no GitHub release.
#
# Steps 2 and 3 let a rerun recover a release that reached JFrog but failed before its tag
# or GitHub release was created: the published version drops out of the publish plan, so
# `changeset publish` alone would never tag it, and `changeset git-tag` only reports tags
# it creates. Tags reach the action through CHANGESETS_OUTPUT, which it reads to push tags
# and create GitHub releases; pushing a tag that already exists only logs a warning.
set -euo pipefail

if [ -n "${PACK_DIR:-}" ]; then
  pnpm exec changeset publish --from-pack-dir "$PACK_DIR"
fi

pnpm exec changeset git-tag

# Changesets tags a single-package repository as v<version>. A tag created above is not on
# origin yet, so it is not reported twice.
name=$(node -p 'require("./package.json").name')
tag="v$(node -p 'require("./package.json").version')"
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
  if ! release=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" 2>&1); then
    if [[ "$release" != *"HTTP 404"* ]]; then
      echo "::error::Could not look up the GitHub release for $tag: $release"
      exit 1
    fi
    echo "$tag has no GitHub release; reporting it to create one."
    jq -nc --arg tag "$tag" --arg name "$name" \
      '{type: "git-tag", tag: $tag, packageName: $name}' >>"$CHANGESETS_OUTPUT"
  fi
fi

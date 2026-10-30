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

# Changesets tags a single-package repository as v<version>.
name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
tag="v$version"

# `ls-remote --exit-code` exits 2 when the tag is absent; any other failure is an error.
remote_tag=0
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || remote_tag=$?
if [ "$remote_tag" -ne 0 ] && [ "$remote_tag" -ne 2 ]; then
  echo "::error::Could not check whether $tag exists on origin (git ls-remote exited $remote_tag)."
  exit 1
fi

if [ -n "${PACK_DIR:-}" ]; then
  pnpm exec changeset publish --from-pack-dir "$PACK_DIR"
fi

# The action tags the commit this run started from. A version this run did not publish
# was built from the commit that set it, so only tag it from that commit: a later push
# would tag a commit newer than the published tarball.
if [ "$remote_tag" -eq 2 ] && [ -z "${PACK_DIR:-}" ]; then
  previous=$(git show HEAD^:package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
  if [ "$previous" = "$version" ]; then
    echo "::error::$version is published but $tag is missing, and this commit did not set $version. Re-run the Release run of the commit that set it."
    exit 1
  fi
fi

pnpm exec changeset git-tag

# A tag created above is not on origin yet, so it is not reported twice.
if [ "$remote_tag" -eq 0 ]; then
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

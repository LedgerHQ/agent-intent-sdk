#!/usr/bin/env bash
# Publish script for changesets/action/publish in release.yml.
#
# 1. Publishes the attested tarball in PACK_DIR, if one was packed.
# 2. Tags the package if its current version has no git tag yet.
#
# Step 2 lets a rerun recover a release that reached JFrog but failed before its tag and
# GitHub release were created: the published version drops out of the publish plan, so
# `changeset publish` alone would never tag it. Both commands report their tags through
# CHANGESETS_OUTPUT, which the action reads to push tags and create GitHub releases.
set -euo pipefail

if [ -n "${PACK_DIR:-}" ]; then
  pnpm exec changeset publish --from-pack-dir "$PACK_DIR"
fi

pnpm exec changeset git-tag

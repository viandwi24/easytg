#!/usr/bin/env bash
# Publishes one package of this repository from the Release workflow.
#
#   bash scripts/publish-package.sh <package folder>     (. for easytg itself)
#
# Needs VERSION and NPM_TAG in the environment (the workflow sets them).
# A version that is already on npm counts as published: one published by hand
# (a package's first version) can take minutes to show up in the registry, so
# it is checked right before publishing and again when npm refuses.
set -uo pipefail

cd "$1"
NAME=$(node -p "require('./package.json').name")

on_npm() {
  npm view "$NAME@$VERSION" version >/dev/null 2>&1
}

if on_npm; then
  echo "::notice::$NAME@$VERSION is already on npm, skipping it"
  exit 0
fi

if npm publish --provenance --access public --tag "$NPM_TAG"; then
  exit 0
fi

# Refused: maybe because it was published meanwhile (and the registry caught up).
for _ in 1 2 3; do
  sleep 20
  if on_npm; then
    echo "::notice::$NAME@$VERSION is on npm (published before this run), skipping it"
    exit 0
  fi
done

echo "::error::npm refused to publish $NAME@$VERSION. Usually: no Trusted Publisher on npmjs.com ($NAME → Settings → Trusted Publisher → GitHub Actions: user viandwi24, repository easytg, workflow release.yml, environment empty), or no NPM_TOKEN secret. Fix it, then re-run this workflow; no new tag is needed."
exit 1

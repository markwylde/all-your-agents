#!/usr/bin/env bash
# Publish the version semantic-release just prepared to GitHub Packages.
# npmjs.com is handled by @semantic-release/npm; this is the second registry.
set -euo pipefail

registry="https://npm.pkg.github.com"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN is not set; skipping the GitHub Packages publish" >&2
  exit 0
fi

npmrc="$(mktemp)"
trap 'rm -f "$npmrc"' EXIT
printf '%s\n' "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >"$npmrc"

# GitHub Packages does not accept provenance attestations, and the tarball is
# already built by prepack.
npm_config_userconfig="$npmrc" npm publish \
  --registry "$registry" \
  --provenance=false \
  --access public

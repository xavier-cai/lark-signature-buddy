#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
remote=${1:-origin}
remote_url=$(git -C "$root" remote get-url "$remote")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/lark-signature-buddy-remote-audit.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init --bare --quiet repository.git
git -C "$tmp/repository.git" fetch --quiet --no-tags "$remote_url" \
  '+refs/heads/*:refs/heads/*' \
  '+refs/tags/*:refs/tags/*' \
  '+refs/pull/*/head:refs/pull/*/head'

GITLEAKS_BIN=${GITLEAKS_BIN:-"$root/.tools/bin/gitleaks"} \
  "$root/scripts/run-gitleaks.sh" history "$tmp/repository.git"

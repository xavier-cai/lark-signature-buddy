#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
zero=0000000000000000000000000000000000000000
scanned=0

while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ -z "${local_sha:-}" || "$local_sha" == "$zero" ]]; then
    continue
  fi
  if [[ "${remote_sha:-$zero}" == "$zero" ]]; then
    range="$local_sha"
  else
    range="$remote_sha..$local_sha"
  fi
  "$root/scripts/run-gitleaks.sh" range "$range"
  scanned=1
done

if [[ "$scanned" == 0 ]]; then
  echo "pre-push: no commits require a security scan"
fi

#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
scope=tracked
range=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) scope=$2; shift 2 ;;
    --range) range=$2; shift 2 ;;
    *) echo "security-audit: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

case "$scope" in
  range)
    if [[ -z "$range" ]]; then
      echo "security-audit: --range is required for range scope" >&2
      exit 2
    fi
    "$root/scripts/run-gitleaks.sh" range "$range"
    ;;
  history)
    "$root/scripts/run-gitleaks.sh" tracked
    "$root/scripts/run-gitleaks.sh" history
    ;;
  tracked|staged|release)
    "$root/scripts/run-gitleaks.sh" "$scope"
    ;;
  *)
    echo "security-audit: unsupported scope '$scope'" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config="$script_root/.gitleaks.toml"
gitleaks_bin=${GITLEAKS_BIN:-}
if [[ -z "$gitleaks_bin" && -x "$root/.tools/bin/gitleaks" ]]; then
  gitleaks_bin="$root/.tools/bin/gitleaks"
elif [[ -z "$gitleaks_bin" ]]; then
  gitleaks_bin=$(command -v gitleaks || true)
fi

if [[ -z "$gitleaks_bin" ]]; then
  echo "gitleaks is required; run 'npm run security:install' or install exactly gitleaks v8.30.1 on PATH" >&2
  exit 2
fi

version=$("$gitleaks_bin" version 2>/dev/null || true)
if [[ "$version" != "8.30.1" ]]; then
  echo "gitleaks v8.30.1 is required, found '${version:-unknown}'; run 'npm run security:install'" >&2
  exit 2
fi
if [[ ! -f "$config" ]]; then
  echo "gitleaks repository config is missing: $config" >&2
  exit 2
fi

run_gitleaks() {
  env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML \
    "$gitleaks_bin" --config "$config" "$@"
}

scope=${1:-tracked}
target=$root

scan_files() (
  local include_untracked=$1
  local scan_root
  scan_root=$(mktemp -d "${TMPDIR:-/tmp}/lark-signature-buddy-gitleaks-files.XXXXXX")
  trap 'rm -rf "$scan_root"' EXIT

  local list_args=(ls-files -z --cached)
  if [[ "$include_untracked" == true ]]; then
    list_args+=(--others --exclude-standard)
  fi
  while IFS= read -r -d '' source; do
    local destination="$scan_root/$source"
    mkdir -p "$(dirname "$destination")"
    if [[ "$include_untracked" == true ]]; then
      if [[ -L "$root/$source" ]]; then
        readlink "$root/$source" > "$destination"
      elif [[ -f "$root/$source" ]]; then
        cp "$root/$source" "$destination"
      else
        echo "run-gitleaks: unable to materialize candidate '$source'" >&2
        exit 2
      fi
    else
      git -C "$root" show ":$source" > "$destination"
    fi
  done < <(git -C "$root" "${list_args[@]}")

  run_gitleaks dir --redact=100 --no-banner --max-archive-depth=1 "$scan_root"
)

case "$scope" in
  tracked)
    scan_files false
    ;;
  staged)
    run_gitleaks git --pre-commit --staged --redact=100 --no-banner \
      --max-archive-depth=1 "$target"
    ;;
  range)
    range=${2:-}
    if [[ -z "$range" || "$range" == --* ]]; then
      echo "run-gitleaks: a commit range is required" >&2
      exit 2
    fi
    run_gitleaks git --redact=100 --no-banner --max-archive-depth=1 \
      --log-opts="--diff-merges=first-parent $range" "$root"
    ;;
  history)
    target=${2:-$root}
    run_gitleaks git --redact=100 --no-banner --max-archive-depth=1 \
      --log-opts="--diff-merges=first-parent --all" "$target"
    ;;
  release)
    scan_files true
    run_gitleaks git --redact=100 --no-banner --max-archive-depth=1 \
      --log-opts="--diff-merges=first-parent --all" "$root"
    ;;
  *)
    echo "run-gitleaks: unsupported scope '$scope'" >&2
    exit 2
    ;;
esac

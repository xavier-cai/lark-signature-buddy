#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
git -C "$root" config core.hooksPath .githooks
chmod 0755 "$root/.githooks/pre-commit" "$root/.githooks/pre-push"
echo "Git hooks installed from .githooks/"

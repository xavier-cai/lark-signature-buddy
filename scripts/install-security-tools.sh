#!/usr/bin/env bash
set -euo pipefail

version=8.30.1
root=$(git rev-parse --show-toplevel)
install_dir="$root/.tools/bin"
platform=$(uname -s)
machine=$(uname -m)

case "$platform/$machine" in
  Darwin/arm64) asset=gitleaks_${version}_darwin_arm64.tar.gz; checksum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin/x86_64) asset=gitleaks_${version}_darwin_x64.tar.gz; checksum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Linux/aarch64|Linux/arm64) asset=gitleaks_${version}_linux_arm64.tar.gz; checksum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Linux/x86_64|Linux/amd64) asset=gitleaks_${version}_linux_x64.tar.gz; checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  *) echo "security tools: unsupported platform $platform/$machine; install gitleaks v$version manually" >&2; exit 2 ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/lark-signature-buddy-gitleaks.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}"
curl --fail --silent --show-error --location \
  --connect-timeout 15 \
  --max-time 300 \
  --retry 3 \
  --retry-all-errors \
  "$url" \
  --output "$tmp/$asset"
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
else
  echo "security tools: shasum or sha256sum is required" >&2
  exit 2
fi
if [[ "$actual" != "$checksum" ]]; then
  echo "security tools: checksum mismatch for $asset" >&2
  exit 1
fi
mkdir -p "$install_dir"
tar -xzf "$tmp/$asset" -C "$install_dir" gitleaks
chmod 0755 "$install_dir/gitleaks"
"$install_dir/gitleaks" version

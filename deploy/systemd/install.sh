#!/usr/bin/env bash
set -euo pipefail

service_name=${LARK_SIGNATURE_BUDDY_SERVICE_NAME:-lark-signature-buddy}
profile=${LARK_SIGNATURE_BUDDY_PROFILE:-lark-signature-buddy}
request_ttl_ms=${LARK_SIGNATURE_BUDDY_REQUEST_TTL_MS:-600000}
node_executable=${LARK_SIGNATURE_BUDDY_NODE:-}
lark_cli_executable=${LARK_SIGNATURE_BUDDY_LARK_CLI:-}
print_only=false
start_service=true

usage() {
  cat <<'EOF'
Usage: deploy/systemd/install.sh [options]

Options:
  --service-name NAME  systemd user service name (default: lark-signature-buddy)
  --profile NAME       lark-cli profile (default: lark-signature-buddy)
  --request-ttl-ms N   partial request lifetime (default: 600000)
  --node PATH          Node.js executable (default: command -v node)
  --lark-cli PATH      lark-cli executable (default: command -v lark-cli)
  --no-start           install and reload without enabling or starting
  --print              print the generated unit without installing it
  -h, --help           show this help
EOF
}

require_value() {
  if [[ $# -lt 2 || -z $2 ]]; then
    printf 'missing value for %s\n' "$1" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name)
      require_value "$@"
      service_name=$2
      shift 2
      ;;
    --profile)
      require_value "$@"
      profile=$2
      shift 2
      ;;
    --request-ttl-ms)
      require_value "$@"
      request_ttl_ms=$2
      shift 2
      ;;
    --node)
      require_value "$@"
      node_executable=$2
      shift 2
      ;;
    --lark-cli)
      require_value "$@"
      lark_cli_executable=$2
      shift 2
      ;;
    --no-start)
      start_service=false
      shift
      ;;
    --print)
      print_only=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! $service_name =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  printf 'invalid service name: %s\n' "$service_name" >&2
  exit 2
fi
if [[ -z $profile || $profile == *$'\n'* ]]; then
  printf 'profile must be a non-empty single-line value\n' >&2
  exit 2
fi
if [[ ! $request_ttl_ms =~ ^[1-9][0-9]*$ ]]; then
  printf 'request TTL must be a positive integer\n' >&2
  exit 2
fi

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_root=$(cd -- "$script_directory/../.." && pwd -P)
template_path="$script_directory/lark-signature-buddy.service.in"

if [[ -z $node_executable ]]; then
  node_executable=$(command -v node || true)
fi
if [[ -z $lark_cli_executable ]]; then
  lark_cli_executable=$(command -v lark-cli || true)
fi
if [[ -z $node_executable || ! -x $node_executable ]]; then
  printf 'Node.js executable not found; pass --node PATH\n' >&2
  exit 1
fi
if [[ -z $lark_cli_executable || ! -x $lark_cli_executable ]]; then
  printf 'lark-cli executable not found; pass --lark-cli PATH\n' >&2
  exit 1
fi

node_executable=$(cd -- "$(dirname -- "$node_executable")" && pwd -P)/$(basename -- "$node_executable")
lark_cli_executable=$(cd -- "$(dirname -- "$lark_cli_executable")" && pwd -P)/$(basename -- "$lark_cli_executable")
bot_entrypoint="$repository_root/apps/bot/src/main.js"

systemd_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}

systemd_path() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//%/%%}
  value=${value// /\\x20}
  value=${value//$'\t'/\\x09}
  printf '%s' "$value"
}

template=$(<"$template_path")
template=${template//@WORKING_DIRECTORY@/$(systemd_path "$repository_root")}
template=${template//@PROFILE_ENVIRONMENT@/$(systemd_quote "LARK_SIGNATURE_BUDDY_PROFILE=$profile")}
template=${template//@REQUEST_TTL_ENVIRONMENT@/$(systemd_quote "LARK_SIGNATURE_BUDDY_REQUEST_TTL_MS=$request_ttl_ms")}
template=${template//@LARK_CLI_ENVIRONMENT@/$(systemd_quote "LARK_SIGNATURE_BUDDY_LARK_CLI=$lark_cli_executable")}
template=${template//@NODE_EXECUTABLE@/$(systemd_quote "$node_executable")}
template=${template//@BOT_ENTRYPOINT@/$(systemd_quote "$bot_entrypoint")}

if $print_only; then
  printf '%s\n' "$template"
  exit 0
fi

config_root=${XDG_CONFIG_HOME:-"${HOME}/.config"}
unit_directory="$config_root/systemd/user"
unit_path="$unit_directory/$service_name.service"
mkdir -p -- "$unit_directory"
temporary_unit=$(mktemp "$unit_directory/.${service_name}.service.XXXXXX")
trap 'rm -f -- "$temporary_unit"' EXIT
printf '%s\n' "$template" >"$temporary_unit"
chmod 0644 "$temporary_unit"
mv -f -- "$temporary_unit" "$unit_path"
trap - EXIT

systemctl --user daemon-reload
if $start_service; then
  systemctl --user enable "$service_name.service"
  systemctl --user restart "$service_name.service"
fi
printf 'installed %s\n' "$unit_path"

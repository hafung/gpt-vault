#!/usr/bin/env bash
set -euo pipefail
project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project"
if [[ ! -x ./bin/gpt-vault ]]; then
  printf '%s\n' 'Build the application with pnpm build first.' >&2
  exit 1
fi

port=8765
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[i]}" in
    --port|-port) port="${args[i+1]:-}" ;;
    --port=*|-port=*) port="${args[i]#*=}" ;;
  esac
done
if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
  printf '%s\n' 'Port must be between 1 and 65535.' >&2
  exit 1
fi

# Resolve the listening process before stopping anything. In particular, do not
# stop another checkout or an unrelated application using the same port.
listeners=$(ss -H -ltnp "sport = :$port")
declare -A owners=()
while IFS= read -r listener; do
  [[ -n "$listener" ]] || continue
  if [[ ! "$listener" =~ pid=([0-9]+) ]]; then
    printf 'Cannot identify the process listening on port %s.\n' "$port" >&2
    exit 1
  fi
  owner="${BASH_REMATCH[1]}"
  executable=$(readlink "/proc/$owner/exe" || true)
  executable="${executable% (deleted)}"
  if [[ "$executable" != "$project/bin/gpt-vault" && "$executable" != "$project/bin/echo-vault" ]]; then
    printf 'Port %s is occupied by another application or another project. It will not be stopped.\n' "$port" >&2
    exit 1
  fi
  owners[$owner]=1
done <<< "$listeners"

if ((${#owners[@]})); then
  printf '%s\n' 'Restarting GPT Vault...'
  kill -TERM "${!owners[@]}"
  deadline=$((SECONDS + 15))
  for owner in "${!owners[@]}"; do
    while [[ -L "/proc/$owner/exe" ]]; do
      if ((SECONDS >= deadline)); then
        printf '%s\n' 'GPT Vault did not stop within 15 seconds.' >&2
        exit 1
      fi
      sleep 0.1
    done
  done
fi
exec ./bin/gpt-vault --open-browser "$@"

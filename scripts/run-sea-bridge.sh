#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${SEA_BRIDGE_ENV_FILE:-$HOME/.config/sea-bridge/env}"

if [[ ! -f "$ENV_FILE" ]]; then
  print -u2 "Sea-Bridge env file not found: $ENV_FILE"
  exit 1
fi

# The env file is expected to be mode 0600 and contain KEY=value lines.
set -a
source "$ENV_FILE"
set +a

BUN_BIN="${SEA_BRIDGE_BUN_BIN:-}"
if [[ -z "$BUN_BIN" ]]; then
  BUN_BIN="$(command -v bun || true)"
fi
if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  print -u2 "Bun executable not found. Set SEA_BRIDGE_BUN_BIN in $ENV_FILE"
  exit 1
fi

cd "$PROJECT_ROOT"
exec "$BUN_BIN" run src/main.ts

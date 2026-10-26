#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${SEA_BRIDGE_ENV_FILE:-$HOME/.config/sea-bridge/env}"

if [[ ! -f "$ENV_FILE" ]]; then
  print -u2 "Sea-Bridge env file not found: $ENV_FILE"
  exit 1
fi

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
if [[ -f "$PROJECT_ROOT/dist/main.js" ]]; then
  exec "$BUN_BIN" run dist/main.js
else
  exec "$BUN_BIN" run src/main.ts
fi


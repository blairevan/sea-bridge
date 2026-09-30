#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$PROJECT_ROOT/poc/dsh-web-connector"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
CONNECTORS_DIR="$DSH_HOME_DIR/connectors"
DEST_DIR="$CONNECTORS_DIR/sea-bridge"
FILES=(index.mjs host-operations.mjs package.json cordis.patch.yml)
MODE="${1:-check}"

usage() {
  printf "%s\n" "Usage: $0 check|install" >&2
  exit 2
}

[[ "$MODE" == "check" || "$MODE" == "install" ]] || usage

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

validate_source() {
  local file
  for file in "${FILES[@]}"; do
    [[ -f "$SOURCE_DIR/$file" && ! -L "$SOURCE_DIR/$file" ]] || {
      printf "%s\n" "Invalid connector source file: $SOURCE_DIR/$file" >&2
      exit 1
    }
  done
}

check_snapshot() {
  [[ -d "$DEST_DIR" && ! -L "$DEST_DIR" ]] || {
    printf "%s\n" "Installed connector snapshot missing: $DEST_DIR" >&2
    return 1
  }
  local file source_hash installed_hash mode
  for file in "${FILES[@]}"; do
    [[ -f "$DEST_DIR/$file" && ! -L "$DEST_DIR/$file" ]] || {
      printf "%s\n" "Installed connector file missing or unsafe: $DEST_DIR/$file" >&2
      return 1
    }
    source_hash="$(sha256_file "$SOURCE_DIR/$file")"
    installed_hash="$(sha256_file "$DEST_DIR/$file")"
    [[ "$source_hash" == "$installed_hash" ]] || {
      printf "%s\n" "Connector snapshot differs: $file" >&2
      return 1
    }
    mode="$(mode_of "$DEST_DIR/$file")"
    (( (8#$mode & 8#077) == 0 )) || {
      printf "%s\n" "Installed connector file is not private: $file" >&2
      return 1
    }
  done
  local dir_mode
  dir_mode="$(mode_of "$DEST_DIR")"
  (( (8#$dir_mode & 8#077) == 0 )) || {
    printf "%s\n" "Installed connector directory is not private: $DEST_DIR" >&2
    return 1
  }
  printf "%s\n" "dsh connector snapshot matches tracked source"
}

validate_source
if [[ "$MODE" == "check" ]]; then
  check_snapshot
  exit $?
fi

mkdir -p "$CONNECTORS_DIR"
chmod 700 "$CONNECTORS_DIR"
[[ ! -L "$CONNECTORS_DIR" ]] || {
  printf "%s\n" "Refusing symlinked connectors directory: $CONNECTORS_DIR" >&2
  exit 1
}

tmp_dir="$(mktemp -d "$CONNECTORS_DIR/.sea-bridge.install.XXXXXX")"
backup_dir="$CONNECTORS_DIR/.sea-bridge.previous.$$"
cleanup() {
  rm -rf "$tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
chmod 700 "$tmp_dir"

for file in "${FILES[@]}"; do
  cp -p "$SOURCE_DIR/$file" "$tmp_dir/$file"
  chmod 600 "$tmp_dir/$file"
done

if [[ -e "$DEST_DIR" ]]; then
  [[ -d "$DEST_DIR" && ! -L "$DEST_DIR" ]] || {
    printf "%s\n" "Refusing unsafe installed connector path: $DEST_DIR" >&2
    exit 1
  }
  mv "$DEST_DIR" "$backup_dir"
fi

if ! mv "$tmp_dir" "$DEST_DIR"; then
  if [[ -d "$backup_dir" && ! -e "$DEST_DIR" ]]; then
    mv "$backup_dir" "$DEST_DIR"
  fi
  printf "%s\n" "Failed to install connector snapshot" >&2
  exit 1
fi
trap - EXIT INT TERM

if ! check_snapshot; then
  rm -rf "$DEST_DIR"
  if [[ -d "$backup_dir" ]]; then
    mv "$backup_dir" "$DEST_DIR"
  fi
  printf "%s\n" "Installed connector verification failed; previous snapshot restored" >&2
  exit 1
fi

rm -rf "$backup_dir" 2>/dev/null || true
printf "%s\n" "Installed dsh connector snapshot. Restart/reload the existing dsh Web Host separately after review."

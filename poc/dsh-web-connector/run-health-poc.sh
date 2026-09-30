#!/usr/bin/env bash
# One-host LaunchAgent swap: health mount only, then restore the original job.
set -euo pipefail

original_plist="$HOME/Library/LaunchAgents/com.deepseek.dsh.plist"
trial_dir=${2:?pass the validated private trial directory}
trial_plist="$trial_dir/dry-run.plist"
original_copy="$trial_dir/original.plist"
socket_path="$HOME/.dsh/run/sea-bridge-poc.sock"
token_path="$HOME/.dsh/run/sea-bridge-poc.token"
job="gui/$(id -u)/com.deepseek.dsh"
domain="gui/$(id -u)"
expected_args="$HOME/.nvm/versions/node/v22.19.0/bin/node $HOME/.nvm/versions/node/v22.19.0/bin/dsh web --no-open --port 3080 --host 127.0.0.1"
probe=probe-health.mjs
if [[ "${1:-health}" == reads ]]; then
  probe=probe-reads.mjs
elif [[ "${1:-health}" != health ]]; then
  printf 'Expected health or reads probe\n' >&2
  exit 2
fi
switched=0

# Restore the original job even if the trial mount or health probe fails.
restore() {
  local result=$?
  trap - EXIT
  if [[ "$switched" == 1 ]]; then
    set +e
    if launchctl print "$job" >/dev/null 2>&1; then
      launchctl bootout "$domain" "$trial_plist" >/dev/null 2>&1 || launchctl bootout "$job" >/dev/null 2>&1
    fi
    if ! cmp -s "$original_copy" "$original_plist"; then
      printf 'Original LaunchAgent changed unexpectedly; leaving backup at %s\n' "$original_copy" >&2
      exit 1
    fi
    launchctl bootstrap "$domain" "$original_plist"
    local restored=0
    for ((attempt = 0; attempt < 20; attempt++)); do
      if lsof -t -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1 &&
        ! test -e "$socket_path" && ! test -e "$token_path"; then
        restored=1
        break
      fi
      sleep 1
    done
    if [[ "$restored" != 1 ]]; then
      printf 'Original Host restoration needs attention; original plist and private backup are intact\n' >&2
      exit 1
    fi
    printf 'Original LaunchAgent restored; PoC socket and token absent\n'
  fi
  exit "$result"
}

trap restore EXIT
trap 'exit 130' INT TERM

# Verify exact service ownership and a private, unchanged trial copy.
test "$(stat -f '%Lp' "$trial_dir")" == 700
test "$(stat -f '%Lp' "$trial_plist")" == 600
cmp -s "$original_copy" "$original_plist"
plutil -lint "$trial_plist" >/dev/null
plutil -extract ProgramArguments json -o - "$original_plist" | node -e '
  let input = ""
  process.stdin.on("data", chunk => input += chunk)
  process.stdin.on("end", () => {
    const args = JSON.parse(input)
    if (args.join(" ") !== process.argv[1]) process.exitCode = 1
  })
' "$expected_args"
original_pid=$(launchctl list | awk '$3 == "com.deepseek.dsh" { print $1 }')
[[ "$original_pid" =~ ^[0-9]+$ ]]
test "$(ps -p "$original_pid" -o args= | sed 's/^ *//')" == "$expected_args"
test "$(lsof -t -nP -iTCP:3080 -sTCP:LISTEN)" == "$original_pid"
test ! -e "$socket_path"
test ! -e "$token_path"

switched=1
launchctl bootout "$domain" "$original_plist"
for ((attempt = 0; attempt < 15; attempt++)); do
  if ! lsof -t -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 1
done
if lsof -t -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port 3080 did not become free; trial Host not started\n' >&2
  exit 1
fi

launchctl bootstrap "$domain" "$trial_plist"
for ((attempt = 0; attempt < 20; attempt++)); do
  if test -S "$socket_path" && test -f "$token_path"; then break; fi
  sleep 1
done
node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$probe"
test "$(lsof -t -nP -iTCP:3080 -sTCP:LISTEN)" != "$original_pid"
printf 'Trial %s mount passed; restoring original job now\n' "$probe"

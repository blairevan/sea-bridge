#!/bin/zsh
# Restart com.aitools.sea-bridge safely.
# By default, schedules a detached restart after a short delay (4s) so that
# an in-flight Sea-Bridge turn (ACP / Codex) can emit its final response
# and persist turn completion before the parent service receives SIGTERM.
set -euo pipefail

DELAY_SECONDS=4
SYNC_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delay)
      DELAY_SECONDS="${2:-4}"
      shift 2
      ;;
    --sync)
      SYNC_MODE=true
      shift
      ;;
    *)
      print -u2 "Usage: $0 [--delay <seconds>] [--sync]"
      exit 1
      ;;
  esac
done

SERVICE_TARGET="gui/$(id -u)/com.aitools.sea-bridge"

if ! launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  print -u2 "Service $SERVICE_TARGET is not loaded in launchctl."
  exit 1
fi

if [[ "$SYNC_MODE" == "true" ]]; then
  launchctl kickstart -k "$SERVICE_TARGET"
  print "Restarted $SERVICE_TARGET synchronously."
  exit 0
fi

nohup sh -c "sleep $DELAY_SECONDS && launchctl kickstart -k '$SERVICE_TARGET'" >/dev/null 2>&1 &
DETACHED_PID=$!
print "Scheduled detached restart of $SERVICE_TARGET in ${DELAY_SECONDS}s (watcher pid: $DETACHED_PID)."

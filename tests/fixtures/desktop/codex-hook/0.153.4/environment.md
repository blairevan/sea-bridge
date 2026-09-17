+# Hook Fixture Environment

_Fill in after running fixture capture on target Desktop._

## Environment

| Item | Value |
|------|-------|
| macOS Version | 26.5 (Build 25F71) |
| ChatGPT Desktop Version | (check About ChatGPT) |
| Embedded Codex Version | 0.153.4 |
| Global Codex CLI Version | 0.147.0 |
| Sea-Bridge Version / Commit | (git rev-parse --short HEAD) |
| Hook wrapper path | /opt/app/aitools/sea-bridge/scripts/codex-hook-bridge.py |
| Hook wrapper SHA-256 | (sha256sum scripts/codex-hook-bridge.py) |
| hooks.json backup path | /Users/<username>/.codex/hooks.json.sea-bridge-backup-2026-09-11T02-51-56.187Z |
| Capture date | 2026-09-11 |
| hooks.json modified | Yes (Sea-Bridge PermissionRequest + event hooks added) |

## hooks feature flag

```
# From: codex --version (embedded in Desktop)
# hooks: stable: true
```

## Fixture Capture Method

Run while Sea-Bridge is NOT running (fixture capture mode):

```bash
cd /opt/app/aitools/sea-bridge
python3 scripts/capture-hook-fixtures.py --output-dir tests/fixtures/desktop/codex-hook/0.153.4
```

Then trigger events in Codex Desktop (send a message, let it use a tool, trigger a PermissionRequest).
Each event is saved as a JSON file in this directory.

## PermissionRequest Trigger Method

To trigger a real PermissionRequest in Codex Desktop:
1. Ask Codex to execute a shell command that would require approval
2. Set Codex permission mode to "ask" (not "auto" or "full-auto")
3. The PermissionRequest hook fires before the tool executes

## Stop Hook Notes

- `stop_hook_active: true` means the Stop event was triggered by another Stop hook; ignore for continuation
- `stop_hook_active: false / absent` means normal turn completion

## Replay / Stale Guard Notes

- Codex 0.153.4: Replays occur when Desktop restarts mid-turn. The `transcript_path` mtime is the best staleness indicator.
- If `sentAt` from wrapper is >30s old when received, treat as stale (transport lag / replay).


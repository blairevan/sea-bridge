# Codex Hook Fixtures

This directory contains captured fixture payloads from real Codex Desktop Hook invocations.
Each version subdirectory corresponds to the embedded Codex version in ChatGPT Desktop.

## Directory Structure

```
tests/fixtures/desktop/codex-hook/
  <version>/
    environment.md              # Desktop/OS/tool versions at capture time
    permissionrequest-*.json    # Real PermissionRequest payloads
    stop-*.json                 # Real Stop payloads
    sessionstart-*.json         # Real SessionStart payloads
    posttooluse-*.json          # Real PostToolUse payloads
    timeout-behavior.md         # Observed behavior when Telegram does not respond
    allow-response-proof.md     # Evidence that allow decision continues execution
    deny-response-proof.md      # Evidence that deny decision stops execution
    stop-continuation-proof.md  # Evidence that Stop + continuation resumes thread
    replay-stale.md             # Observed stale/replay cases
```

## Capturing Fixtures

Run the capture server while Sea-Bridge is NOT running:

```bash
cd /opt/app/aitools/sea-bridge
python3 scripts/capture-hook-fixtures.py --output-dir tests/fixtures/desktop/codex-hook/<version>
```

The server responds with null output to all events (Codex proceeds normally).

## Security

- Redact all tokens, secrets, passwords, cookies, and API keys before committing.
- Do not commit the actual Bot token, ALLOWED_USER_ID, or ALLOWED_CHAT_ID.
- Transcript paths and session IDs in fixtures are acceptable (local paths only).
- Tool inputs containing sensitive data must be redacted with `[REDACTED]`.

## Contract Gate

The DESKTOP_APPROVAL capability moves from `pending_contract` to `available` only after:
1. At least one real PermissionRequest fixture is captured;
2. allow and deny responses are verified to produce the correct Desktop behavior;
3. The timeout behavior is observed and documented;
4. These fixtures pass the contract tests in `tests/codex-hook-provider.test.ts`.

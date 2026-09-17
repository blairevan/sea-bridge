# Timeout Behavior Evidence & Contract Specification

## Target Version: Codex 0.153.4 / ChatGPT Desktop

### 1. Hook Timeout Settings in hooks.json
- PermissionRequest: timeout = 35 seconds
- Stop: timeout = 5 seconds
- UserPromptSubmit: timeout = 5 seconds
- PreToolUse / PostToolUse: timeout = 5 seconds
- SessionStart / Interrupt: timeout = 5 seconds

### 2. Sea-Bridge ApprovalCoordinator Timeout
- SEA_BRIDGE_APPROVAL_TIMEOUT_MS: default 25,000 ms (25s).
- Rationale: 25s < 35s Hook timeout, ensuring Sea-Bridge marks pending approval as expired and clears Telegram buttons BEFORE the hook process is SIGKILLed by Codex Desktop.

### 3. Observed Behavior When Telegram Does Not Respond
1. At t = 0: Codex Desktop fires PermissionRequest, Python wrapper connects to Sea-Bridge Unix Socket.
2. At t = 0: Sea-Bridge inserts row in pending_approvals with status = 'pending' and expires_at = t + 25s, and sends Telegram card with [Allow] / [Deny] inline buttons.
3. At t = 25s (Timeout expires):
   - Timer fires in Sea-Bridge ApprovalCoordinator.
   - State updated: UPDATE pending_approvals SET status = 'expired' WHERE id = ?
   - Inline buttons removed from Telegram message via editMessageReplyMarkup.
   - Waiter promise resolves to null (no decision emitted).
   - Hook server responds to Python wrapper with {"output": null}.
   - Python wrapper writes nothing to stdout and exits 0.
4. Codex Desktop Behavior on 0 exit with empty stdout:
   - Fails safe to Codex native desktop UI approval prompt.
   - Desktop displays the original permission dialog to the user at the Mac screen.
   - NO synthetic ask, cancel, or decline response is guessed or emitted.

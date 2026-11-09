# Antigravity ACP (`agy 1.5.2`) P0 Verification & PoC Report

- **Date**: 2026-11-09
- **Binary**: `/Users/zhuhaijun/.local/bin/agy` (`1.5.2`)
- **Desktop App**: `/Applications/Antigravity.app` (`2.29.0`, `~/.gemini/antigravity`)
- **Isolation Check**: Executed with temporary `--gemini-dir` and `--app-data-dir` (symlinking only read-only OAuth credentials); verified `mtimeMs` of both `~/.gemini/antigravity/conversation_summaries.db` and `~/.gemini/antigravity-cli/conversation_summaries.db` remained unchanged (`desktopDbTouched: false`, `cliDbTouched: false`).

---

## 1. Handshake & Capabilities (`initialize`)
- **Request**: `{ protocolVersion: 1, clientInfo: { name, version }, clientCapabilities: {} }`
- **Response**:
  - `protocolVersion: 1`
  - `agentInfo: { name: "agy", title: "Antigravity CLI", version: "1.5.2" }`
  - `agentCapabilities.loadSession: true`
  - `agentCapabilities.sessionCapabilities`: `{ close: {}, fork: {}, list: {}, resume: {} }`

## 2. Session Creation & Model / Reasoning Effort Contract (`session/new` & `session/set_config_option`)
- `session/new` (`{ cwd, mcpServers: [] }`) returns:
  - `sessionId`: UUID v4 string
  - `models`: `{ currentModelId: "gemini-4-argon-medium", availableModels: [...] }` (13 variant entries)
  - `modes`: `{ currentModeId: "default", availableModes: ["default", "accept-edits", "plan"] }`
  - `configOptions`:
    1. `id: "model"` (`category: "model"`, `currentValue: "gemini-4-argon"`): 5 base options (`gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`).
    2. `id: "thought_level"` (`category: "thought_level"`, `currentValue: "medium"`): 3 options (`low`, `medium`, `high`).
    3. `id: "mode"` (`category: "mode"`, `currentValue: "default"`).
- `session/set_config_option`:
  - Supports separate updates: `{ sessionId, configId: "model", value: "gemini-3.8-flash" }` and `{ sessionId, configId: "thought_level", value: "low" }`.
  - Also supports combined variant ID on `configId: "model"` (`value: "gemini-3.8-flash-low"`), which updates both `model` and `thought_level`.
  - When `model` is set to `"gpt-oss-120b-medium"`, the returned `configOptions` omits `thought_level` completely (confirming single-tier model behavior).

## 3. Multi-Turn Streaming, Permission Approval & Cancellation
- `session/prompt` (`{ sessionId, prompt: [{ type: "text", text }] }`) streams `session/update` notifications:
  - `available_commands_update`, `user_message_chunk`, `session_info_update`, `agent_message_chunk`, `tool_call`.
  - Final RPC response returns `{ stopReason: "end_turn" | "cancelled" | ..., usage: { inputTokens, outputTokens, thoughtTokens, totalTokens } }`.
- `session/request_permission`:
  - Sent as a server-to-client JSON-RPC request with a **string** `id` (e.g. `"id": "1"`).
  - Contains `params.sessionId`, `params.toolCall` (`toolCallId`, `name`, `args`, `title`, `kind`), and `params.options` (`[{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }]`).
  - Client replies with `{ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } }` or `{ outcome: { outcome: "cancelled" } }`.
- `session/cancel`:
  - Sent as a client-to-server notification `{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }`.
  - If a permission request is pending, replying `{ outcome: { outcome: "cancelled" } }` together with `session/cancel` resolves `session/prompt` with `{ stopReason: "cancelled" }`.

## 4. Session List, Load (Replay) & Resume
- `session/list` (`{ cwd }`) returns `{ sessions: [{ sessionId, cwd, title, updatedAt }] }`.
- `session/load` (`{ sessionId, cwd, mcpServers: [] }`) replays all historical `session/update` notifications (`user_message_chunk`, `tool_call`, `agent_message_chunk`) **before** resolving the `session/load` RPC response.
- `session/resume` (`{ sessionId, cwd, mcpServers: [] }`) reattaches the session **without** emitting historical `session/update` notifications (`resumeUpdateCount: 0`).
- `session/close` (`{ sessionId }`) cleanly closes the active session and returns `{}`.

## 5. P4 Desktop (`Antigravity.app`) & `agy` CLI Write-Interoperability Verification
Executed in isolated `/tmp/agy-p4-lab-*` environments with copies of `antigravity-cli` (`b001e877-ba98-453d-8afd-e8d264f8a3c9`) and `antigravity` Desktop (`179769f3-7ccb-4db6-a829-aa6baa9bac2d`, `94a12d66-b809-4caa-a431-029ca63b2013`) conversations, while holding concurrent SQLite WAL connections simulating `Antigravity.app` (`language_server --subclient_type hub`):
1. **Per-Directory Storage Binding (`--app-data-dir`)**:
   - `agy acp` resolves `conversations/<sessionId>.db` and `brain/<sessionId>` strictly inside `<geminiDir>/<appDataDir>`.
   - Calling `session/load` on a Desktop session (`antigravity`) from an `--app-data-dir=antigravity-cli` worker yields `0` history steps because the `.db` file resides under `antigravity/conversations/`.
   - Spawning `agy acp` with `--app-data-dir=antigravity` for Desktop-origin sessions (`sessionOrigin === "desktop"`) loads and resumes the exact native Desktop session (`sameSessionId: true`, 6 replayed history chunks) with **zero duplicate/imported copies** (`convFiles` contains only `<deskId>.db`, `.db-wal`, `.db-shm`).
2. **In-Place Write & Cross-Process SQLite WAL Compatibility**:
   - With concurrent SQLite WAL connections held on `antigravity/conversation_summaries.db` and `antigravity/conversations/<deskId>.db`, running `session/resume` + `session/prompt` via `agy acp --app-data-dir=antigravity`:
     - Preserved `sessionId === "179769f3-7ccb-4db6-a829-aa6baa9bac2d"` (`stopReason: "end_turn"`);
     - Appended steps in-place in `conversations/<deskId>.db` (`steps` count `2 -> 5`, `PRAGMA integrity_check: "ok"`);
     - Appended `USER_INPUT` and `PLANNER_RESPONSE` lines in-place in `brain/<deskId>/.system_generated/logs/transcript.jsonl` (`2 -> 5` lines).
3. **Critical Lifecycle Requirement (`closeSession` + Worker Retirement on Desktop Sessions)**:
   - While an `agy acp --app-data-dir=antigravity` worker stays open after `session/prompt`, `conversation_summaries.db` remains at `status = 'CASCADE_RUN_STATUS_RUNNING'`, `not_fully_idle = 1`.
   - Calling `session/close` and terminating the worker after turn completion immediately flushes WAL frames and transitions `conversation_summaries.db` to `step_count = 5`, `status = 'CASCADE_RUN_STATUS_IDLE'`, `not_fully_idle = 0`.
   - Therefore, SeaBridge must retire the `agy acp` worker immediately after each completed turn on a `desktop`-origin session, and must check `conversation_summaries.db` (`status === 'CASCADE_RUN_STATUS_RUNNING' || not_fully_idle === 1`) before dispatching any write to prevent concurrent dual-writer turns.
4. **Read-Only WAL Without `-shm` Fallback**:
   - When `Antigravity.app` or `agy` exits cleanly and removes `.db-shm` while leaving the database file header in WAL mode (`0x02`), `new Database('file:...?mode=ro', { readonly: true })` returns `SQLITE_CANTOPEN` (`errno: 14`). Falling back to `file:...?immutable=1` allows read-only inspection when no `.db-shm` file is present.
5. **CLI Stub Filtering in `antigravity/conversation_summaries.db`**:
   - `antigravity/conversation_summaries.db` contains stub rows with `source = 'CORTEX_TRAJECTORY_SOURCE_CLI'` whose `.db` and `brain/` files live in `antigravity-cli/`. `AntigravityDesktopReader` must exclude `source = 'CORTEX_TRAJECTORY_SOURCE_CLI'` so untitled CLI stubs do not pollute Desktop session lists.

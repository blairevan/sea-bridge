# Antigravity ACP (`agy 1.5.2`) Sanitized Fixtures

These sanitized JSON-RPC / CLI fixtures capture the verified wire contract of `/Users/zhuhaijun/.local/bin/agy acp` and `agy models` (`1.5.2`) recorded during the P0 isolated verification on 2026-11-09.

## Files
- `initialize.json`: Request/response pair for `initialize`.
- `session-new.json`: Request/response pair for `session/new` (including `models`, `modes`, and `configOptions` with separate `model` and `thought_level`).
- `set-config-option.json`: Request/response pairs for `session/set_config_option` (`model`, `thought_level`, and single-tier `gpt-oss-120b-medium` where `thought_level` is omitted).
- `prompt-turn.json`: Request, streaming `session/update` notifications, and final result for `session/prompt`.
- `request-permission.json`: Inbound `session/request_permission` RPC request (note string `id`), client `selected` / `cancelled` response, and subsequent `tool_call` status update.
- `session-load.json`: Request, replayed `session/update` notifications, and final RPC result for `session/load`.
- `agy-models.txt`: Raw stdout output from `agy models`.

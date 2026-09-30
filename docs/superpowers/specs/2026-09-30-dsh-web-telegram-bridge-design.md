# Design Spec: dsh Web ↔ Telegram Bridge

- **Date**: 2026-09-30
- **Branch**: `feature/dsh-web-bridge-design`
- **Project**: sea-bridge
- **Status**: Approved in conversation; awaiting written-spec review

## 1. Goal

Add dsh Web integration to Sea-Bridge, matching the existing Codex Telegram workflow for notifications, precise replies to existing sessions, and creating a new session. Existing Codex behavior and commands remain unchanged. The target is the dsh Web profile and its owning Host process; TUI is not a target in this scope.

Telegram dsh commands use the `dsh` prefix:

- `/dsh_status`
- `/dsh_projects`
- `/dsh_model`
- `/dsh_new`

The exact Telegram command naming must follow Telegram's command syntax and stay within its command-length limits.

## 2. Existing Codex Reference

Sea-Bridge currently separates the Codex integration into three paths:

1. `CodexThreadStore` and `ThreadHistoryStore` read Codex state/history databases. `DesktopObserver` polls incrementally, baselines existing history on startup, fingerprints events, and sends deduplicated Telegram notifications.
2. Telegram replies resolve the notification-to-thread mapping and invoke `codex queue --thread <threadId> --message <text>` using an argument array.
3. Telegram new-session actions use a separate `codex app-server --stdio` JSON-RPC client. Project and model lists come from `project/list` and `model/list`; creation and first-turn execution use `thread/start` followed by `turn/start` in the same app-server context.

This is the reference for separation of responsibilities, exact session routing, idempotency, and delivery-state reporting. dsh must use its own supported interfaces rather than reusing Codex storage or process assumptions.

## 3. Architecture

Add a dsh-specific adapter boundary alongside the existing Codex adapters:

- **dsh Web Host connector**: a narrow, authenticated local channel into the currently running Web Host. It owns session listing/observation, project and model discovery, prompt submission, and session creation. The connector must call the Web Host's session controller so an already-held session is never claimed by a second dsh writer.
- **dsh observer**: consumes durable session events or history from a supported dsh interface, maintains per-session cursors, and feeds a dsh notification outbox. It does not modify dsh persistence files. The transport and event source are selected only after the PoC in Section 4.
- **Telegram dsh adapter**: implements the prefixed commands and maps Telegram notification messages to `(provider=dsh, sessionId, eventId)` identities. Provider identity is part of all routing and idempotency keys so a Codex notification cannot route to dsh and vice versa.
- **Shared Telegram client/security primitives**: reuse current authorization, redaction, message formatting, and Telegram transport where their semantics match. Keep provider-specific session stores, cursors, delivery state, and error classification separate.

The intended flows are:

```text
dsh Web Host durable events/history -> dsh observer -> Telegram notification + dsh mapping
Telegram reply to mapped notification -> dsh Web Host session controller -> same dsh Web session
/dsh_new -> Web Host projects/models -> Web Host create + first prompt -> observer notification
```

No fallback may launch another dsh profile to resume or write a session. If the Web Host connector is unavailable, dsh commands report unavailable and Codex continues to work.

## 4. Required Host-Interface PoC Gate

Before implementation, a target-Mac PoC must verify the installed dsh version and the exact supported Host contracts. In particular it must prove:

1. Sea-Bridge can authenticate to the active Web Host over a local, non-public channel without extracting or logging browser credentials or process tokens.
2. The Host can list existing sessions and provide incremental durable events/history with stable session IDs, cursors, titles, turn outcomes, and assistant final text.
3. A Telegram-originated prompt reaches the addressed session through the same live Host and is observed in that session's durable history.
4. The Host can enumerate projects and currently available models, create a session for a selected project/model, and accept its first prompt in the same operation context.
5. Concurrent session ownership is respected; contention is reported without launching another writer or silently targeting a different session.
6. Reconnect/restart, duplicate Telegram updates, Host restart, unavailable Host, and ambiguous submission outcomes have observed and recorded behavior.

The PoC records version, interface/event contract, sanitized request/response shapes, and outcome evidence. It must not store secrets or session message bodies in the design artifact. If any write or event contract is not proven, that capability remains unavailable; no direct persistence mutation or guessed private endpoint is an acceptable substitute.

## 5. Telegram Behavior

### 5.1 Existing sessions and notifications

- Observe dsh Web sessions through the verified Host interface. On first start, establish a baseline instead of replaying old history.
- Notify on the same verified terminal turn outcomes used by the Codex integration: completed, failed, and interrupted. Include a dsh source label and session title, plus a redacted/truncated final-text summary when available.
- Persist an idempotent mapping from the Telegram message to the exact dsh session and event. Replies to a mapped message always target that session, regardless of which provider produced the most recent Telegram notification.
- Preserve Telegram user/chat authorization. Plain text without a valid mapped dsh notification must not be guessed onto a dsh session. Existing Codex reply behavior remains unchanged.

### 5.2 New sessions

- `/dsh_projects` lists projects exposed by the running Web Host; stale or inaccessible paths are not presented as selectable.
- `/dsh_model` lists models exposed by the running Web Host and stores a per-chat preference for subsequent dsh-created sessions. An unavailable model list does not trigger a hard-coded fallback.
- `/dsh_new` selects a project, uses the selected model or Web Host default, then collects a first prompt. Pending selection state is durable, expires, and is single-use.
- A creation-success response is sent only after the Host confirms both session creation and first-prompt acceptance. The confirmation message is mapped to the new dsh session for follow-up replies.

### 5.3 Status

`/dsh_status` reports Web Host reachability and separately reports the verified availability of observation, reply, project/model discovery, and session creation. A reachable Host alone does not imply that every capability is available.

## 6. Delivery, Failure, and Security

- Use Telegram update IDs for inbound idempotency and stable dsh session/event identities for outbound deduplication.
- Distinguish accepted-by-Host from observed/executed. Only report prompt acceptance when the Host's documented response proves admission; later turn notifications provide execution evidence.
- For an ambiguous write result, record `delivery_unknown`, notify the user, and do not automatically replay a potentially side-effecting prompt.
- Report Host-offline, session-missing, writer-held, validation, and provider errors as explicit dsh statuses. Never silently reroute to Codex, another dsh session, or a new process.
- Use parameterized/protocol calls rather than shell interpolation. Redact session content and secrets from logs; bound notification length and apply existing redaction before Telegram delivery.
- dsh and Codex session mappings, cursors, and delivery idempotency remain provider-scoped.

## 7. Testing and Acceptance

Automated tests must cover:

1. dsh Host connector contract and error mapping using sanitized fixtures;
2. incremental event observation, startup baseline, cursor persistence, and notification deduplication;
3. exact notification-to-session reply routing and provider isolation from Codex;
4. authorization, duplicate Telegram updates, unknown delivery outcomes, and writer contention;
5. prefixed command parsing, project/model selection, expiring pending prompts, and create-plus-first-prompt acceptance;
6. regressions: existing Codex notification, reply, `/new`, `/projects`, `/model`, and `/status` behavior remains unchanged.

Target-Mac end-to-end acceptance must demonstrate:

1. an existing dsh Web session turn produces one Telegram notification;
2. replying to that notification reaches that exact session in the active Web Host;
3. `/dsh_new` creates and starts a session under the selected project/model, then a reply to its Telegram notification continues that session;
4. Sea-Bridge restart does not replay baseline history or duplicate notifications/deliveries;
5. Codex and dsh notifications remain isolated and both providers continue to work.

Static tests alone do not establish the live dsh Web Host behavior; target-Mac PoC and end-to-end results must be reported separately.

## 8. Non-Goals

- dsh TUI integration or simultaneous TUI/Web control of the same session;
- remote approvals, interrupts, arbitrary shell execution, or web-profile administration from Telegram;
- modifying dsh session files/database directly;
- replacing or changing the existing Codex integration;
- exposing the dsh Web Host to the LAN/public internet for Sea-Bridge connectivity.

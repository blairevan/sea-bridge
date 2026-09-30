# Design Spec: dsh Web ↔ Telegram Bridge

- **Date**: 2026-09-30
- **Branch**: `feature/dsh-web-bridge-design`
- **Project**: sea-bridge
- **Status**: Reviewed and revised — ready for implementation planning; Phase 0 Host PoC remains a mandatory implementation gate
- **Last Review**: 2026-09-30

## 0. Review Findings and Design Decisions

The written-spec review found several issues that would otherwise create routing, migration, or duplicate-write risks. This revision makes the following decisions explicit:

1. **Do not retrofit dsh into the existing Codex-specific persistence tables.** Existing tables such as `desktop_message_links`, `telegram_thread_deliveries`, `desktop_observer_cursors`, `desktop_notification_outbox`, and `pending_new_thread_prompts` keep their current Codex semantics. dsh gets provider-specific tables/stores, while Telegram routing composes both providers.
2. **Exact Telegram reply routing is provider-aware.** A reply to a mapped dsh message goes only to dsh; a reply to a mapped Codex message goes only to Codex. Existing no-reply plain-text behavior continues to target the latest Codex mapping and never guesses a dsh session.
3. **dsh session creation requires durable write intent before calling the Host.** A crash or timeout after the Host accepts creation must not cause automatic replay and duplicate sessions. Ambiguous creation or prompt submission is persisted as `delivery_unknown`.
4. **Telegram callback data must not embed arbitrary Host identifiers.** Telegram callback payloads are size-limited and Host project/model/session identifiers may be long or sensitive. dsh menus use short opaque callback tokens backed by durable/expiring server-side state.
5. **Observer startup must not swallow the first turn of a Sea-Bridge-created dsh session.** Bridge-created session markers are registered as soon as a session identity is known, so the first post-creation terminal event remains deliverable even while ordinary pre-existing sessions are baselined.
6. **Host capabilities are gated independently.** Host reachability, observation, existing-session reply, project discovery, model discovery, and session creation can be available or unavailable independently. No unverified capability is inferred from a successful health check.
7. **Concurrent writes are never guessed or force-taken over.** If the Host reports busy/writer-held/turn-active and does not document queue semantics, Sea-Bridge reports that state and does not auto-retry the prompt.
8. **Saved dsh preferences are namespace-isolated from Codex.** If the shared `user_preferences` table is reused, dsh keys use a `dsh.` namespace and never reuse Codex's `default_model` key.

## 1. Goal

Add dsh Web integration to Sea-Bridge, matching the existing Codex Telegram workflow for notifications, precise replies to existing sessions, and creating a new session. Existing Codex behavior and commands remain unchanged. The target is the dsh Web profile and its owning Host process; TUI is not a target in this scope.

Telegram dsh commands use the `dsh` prefix:

- `/dsh_status`
- `/dsh_projects`
- `/dsh_model`
- `/dsh_new`

These names satisfy Telegram command syntax and length requirements. Bot-command synchronization must merge the existing Codex commands and the dsh commands; transient dsh Host unavailability must not remove or alter the Codex command set.

## 2. Existing Codex Reference and Compatibility Boundary

Sea-Bridge currently separates the Codex integration into three paths:

1. `CodexThreadStore` and `ThreadHistoryStore` read Codex state/history databases. `DesktopObserver` polls incrementally, baselines existing history on startup, fingerprints events, and sends deduplicated Telegram notifications.
2. Telegram replies resolve the notification-to-thread mapping and invoke `codex queue --thread <threadId> --message <text>` using an argument array.
3. Telegram new-session actions use a separate `codex app-server --stdio` JSON-RPC client. Project and model lists come from `project/list` and `model/list`; creation and first-turn execution use `thread/start` followed by `turn/start` in the same app-server context.

This remains the Codex implementation. dsh must use its own supported Host interfaces and must not reuse Codex storage/process assumptions.

Compatibility requirements:

- Existing Codex database rows are not rewritten or migrated into dsh semantics.
- Existing `/status`, `/projects`, `/model`, `/new`, Codex notification delivery, reply callbacks, and no-reply plain-text routing keep their current behavior.
- A failure in dsh connector discovery, authentication, polling, or shutdown must not prevent the Codex path or Telegram polling loop from starting.
- dsh startup is fail-soft: unavailable capabilities are reflected in `/dsh_status` and retried with bounded backoff where safe.

## 3. Architecture

Add a dsh-specific adapter boundary alongside the existing Codex adapters:

- **dsh Web Host connector**: a narrow local client for the currently running Web Host. It owns health/capability discovery and the verified operations for session observation, project/model discovery, prompt submission, and session creation. It never launches a second dsh profile/Host as a fallback.
- **dsh observer**: consumes durable session events/history from a supported Host interface, maintains per-session observation state, and feeds a dsh notification outbox. It never modifies dsh persistence files.
- **Telegram provider router**: resolves exact Telegram reply mappings across Codex and dsh before dispatching to the provider-specific reply adapter.
- **Telegram dsh adapter**: implements prefixed commands, dsh callback namespaces/tokens, and dsh-specific pending-new-session flows.
- **Provider-specific state stores**: dsh message links, delivery state, observer cursors/high-water marks, notification outbox, callback tokens, creation requests, and pending prompts are stored separately from Codex tables.
- **Shared Telegram/security primitives**: reuse current authorization, Telegram transport, retry primitives, redaction, and formatting where their semantics match.

The intended flows are:

```text
verified dsh Host history/events
  -> dsh observer
  -> dsh notification outbox
  -> Telegram message
  -> dsh message mapping

Telegram reply to mapped dsh message
  -> provider router
  -> dsh reply adapter
  -> active Web Host session controller
  -> exact dsh session

/dsh_new
  -> opaque project selection
  -> durable creation request
  -> active Web Host create/session controller
  -> first prompt admission
  -> created-session observer marker
  -> Telegram acknowledgement + mapping
  -> later observer notification
```

No fallback may launch another dsh profile to resume or write a session. No dsh operation silently reroutes to Codex or to another dsh session.

## 4. Required Host-Interface PoC Gate

### 4.1 Gate model

Phase 0 runs on the target Mac against the installed dsh Web Host version. The implementation plan may be written before the PoC, but no production dsh write path is enabled until the corresponding contract is proven.

The PoC has a **core transport gate** plus **per-capability gates**:

- **Core transport**: supported Host endpoint discovery, local-only transport, authentication/access control if required, health/reconnect behavior, and version/contract fingerprint.
- **Observation**: session enumeration plus durable history/events sufficient for restart-safe incremental observation.
- **Reply**: exact-session prompt submission and documented admission/busy/error semantics.
- **Project discovery**: current projects and stable identities usable for session creation.
- **Model discovery**: models/default-model behavior and whether availability is global or project-dependent.
- **Creation**: create session plus first-prompt admission, including ambiguous outcomes and concurrency behavior.

A capability remains disabled when its own gate is not proven. One missing optional capability does not create guessed behavior in another capability.

### 4.2 What must be proven

The PoC must verify and record:

1. The installed dsh version and Host contract/version fingerprint.
2. The supported local endpoint: Unix socket, loopback HTTP/WebSocket/SSE, or another documented Host-local transport. Sea-Bridge must not widen the Host bind address or expose it to LAN/public networks.
3. The Host's supported authentication mechanism, if any. Sea-Bridge may use documented application credentials/tokens only through a supported source; it must not scrape browser storage, process memory, or logs for credentials.
4. Session identity stability across reconnect and Sea-Bridge restart.
5. For observation, either:
   - a documented stable cursor/sequence/event ID; or
   - immutable event/turn identities and ordering metadata sufficient to derive a persistent high-water mark without replaying old history.
6. The available terminal outcomes and whether final assistant text is present. Sea-Bridge only emits outcome labels the Host actually proves and treats final text as optional.
7. For reply, a Telegram-originated prompt reaches the addressed live Web session and later appears in that session's durable history.
8. Busy/active-turn/writer-held behavior. If the Host does not document queue semantics, Sea-Bridge treats the condition as non-delivery and does not automatically queue/replay.
9. For creation, project/model/session APIs, project-path validation, model availability semantics, session creation, first-prompt admission, and the returned session/turn identifiers.
10. Host restart, connector reconnect, duplicate Telegram updates, Sea-Bridge restart during a write, unavailable Host, and timeout/connection-loss after submission.

The PoC artifact records sanitized request/response shapes, observed error classes, and outcome evidence. It must not contain secrets or session message bodies.

If a write or observation contract is not proven, that capability stays unavailable. Direct dsh database/session-file mutation, private-endpoint guessing, UI automation, and starting another dsh writer are outside the fallback set.

## 5. Persistence and Provider Isolation

### 5.1 Existing tables remain Codex-specific

This change does not add provider semantics to the existing Codex tables. In particular, do not reinterpret:

- `desktop_message_links`
- `telegram_thread_deliveries`
- `desktop_observer_cursors`
- `desktop_notification_outbox`
- `pending_new_thread_prompts`

This avoids a risky migration where existing rows have no provider column and preserves the current Codex code path.

### 5.2 dsh state

The implementation plan should introduce dsh-specific equivalents with session-oriented naming, for example:

- `dsh_message_links`
- `dsh_deliveries`
- `dsh_observer_cursors` or `dsh_observation_state`
- `dsh_notification_outbox`
- `dsh_callback_tokens`
- `dsh_creation_requests`
- `dsh_pending_new_session_prompts`
- `dsh_created_sessions`

Exact columns follow the verified Host contract, but the following identities are mandatory:

- message link: `(telegram_chat_id, telegram_message_id) -> dsh_session_id`
- outbound deduplication: stable `(session_id, event_id/turn_id, event_kind)` identity, hashed if needed
- reply delivery: Telegram `update_id` as the inbound idempotency key
- creation request: Telegram `update_id` or another unique Telegram-origin operation ID as the durable idempotency key
- callback token: short random/opaque token -> provider action + Host identity + expiry; persist only a one-way hash of the opaque token, not the raw callback secret

The transport-level `telegram_updates` table remains shared because Telegram update IDs are globally unique for the bot and its purpose is whole-update processing idempotency, not provider routing.

The existing `user_preferences` table may be shared only with namespaced dsh keys, for example `dsh.default_model`. dsh must not read or overwrite Codex's `default_model`.

### 5.3 Migration rule

All dsh schema creation must be additive and safe against an existing Sea-Bridge database. Automated migration tests must start from a database containing current Codex rows, apply the new migration, and prove that existing rows and behavior remain intact.

## 6. Telegram Routing and Commands

### 6.1 Exact reply routing precedence

For a message that replies to another Telegram message:

1. Look up an exact dsh mapping for `(chatId, reply_to_message_id)`.
2. Look up the existing exact Codex mapping for the same Telegram message.
3. Exactly one provider mapping is expected. If both exist, treat it as an invariant violation, log provider-safe metadata, and do not dispatch.
4. Dispatch only to the resolved provider.
5. If neither exists, preserve the current unmapped-reply behavior; do not fall back to a latest dsh session.

For plain text with no Telegram reply target:

- preserve the current Codex `findLatestLink(chatId)` behavior;
- do not consider dsh mappings;
- therefore adding dsh does not change the existing direct-input semantics.

dsh notification “Reply” buttons use a dsh-specific callback namespace such as `dsh:reply:<token>`. The token resolves server-side to the target session/message mapping. Raw session IDs are not placed in callback data.

### 6.2 Callback safety

Telegram `callback_data` is bounded, so dsh project/model/session identifiers are never assumed to fit. Use short opaque tokens with:

- provider/action type;
- target Host identity stored server-side;
- chat binding;
- expiry for menus/pending selections;
- single-use semantics where the action mutates state.

Unknown, expired, wrong-chat, or already-consumed tokens produce a safe message and no Host call.

### 6.3 Existing sessions and notifications

- Observe dsh Web sessions through the verified Host interface.
- On the first enablement of ordinary pre-existing sessions, establish a baseline instead of replaying old history.
- Notify only for verified terminal outcomes. Typical expected states are completed, failed, and interrupted, but the adapter must not invent a state the Host contract does not expose.
- Include a dsh source label and session title, plus a redacted/truncated final-text summary when available.
- Telegram-send failures stay in the durable dsh outbox and retry with bounded backoff. A notification is marked sent only after the Telegram message ID and dsh reply mapping are persisted atomically. A mapping-key conflict is an invariant failure and rolls back the outbox completion rather than silently marking the notification sent.
- Replies to a mapped dsh notification always target that exact session.

### 6.4 Bridge-created session observation

A newly created dsh session must not be mistaken for pre-existing history and baselined away.

As soon as the Host returns a stable new session ID, Sea-Bridge persists a `dsh_created_sessions` marker before it can lose the creation context. The observer uses that marker to make the first post-creation terminal event deliverable.

If the Host exposes only an atomic “create + first prompt” operation and returns the session ID after admission, the marker is persisted immediately on the successful response. The implementation must test the race where the first turn completes before the next observer poll.

### 6.5 Projects

`/dsh_projects` lists projects exposed by the running Host.

Requirements:

- do not present entries the Host already marks unavailable;
- revalidate the selected project at callback handling time;
- revalidate again immediately before session creation when the Host contract supports it;
- do not trust a stale filesystem path cached only by Telegram state;
- handle duplicate project names without guessing;
- if the Host has project-scoped model availability, preserve that project context for model validation.

### 6.6 Models

`/dsh_model` lists verified Host models and offers “use Host default”.

A selected model is a preference, not proof that the model will remain available later. Before creating a session:

- validate the saved model against the current Host/project context when the Host supports validation;
- if it is no longer available, fail explicitly and ask the user to choose another model or Host default;
- do not silently substitute a different model.

If model discovery is unavailable, Sea-Bridge does not invent a model list and does not erase the existing preference.

### 6.7 New sessions

`/dsh_new` selects a project, applies the dsh model preference or Host default, and collects a first prompt. Pending state is durable, expires, and is single-use.

The new-session flow must use a durable creation state machine:

```text
received
  -> dispatching
  -> accepted
  -> acknowledged

dispatching
  -> delivery_unknown   (timeout / connection loss / crash-recovery ambiguity)

received|dispatching
  -> failed             (proven rejection with no side effect)
```

Rules:

1. Persist the creation request before the first side-effecting Host call.
2. If the Host supports an idempotency/client-request key, pass a stable value derived from the Telegram operation ID.
3. A proven Host rejection may be retried by a new explicit user action.
4. A timeout, connection loss, or process restart after dispatch starts becomes `delivery_unknown` unless the Host provides a reliable reconciliation API.
5. Never automatically replay `delivery_unknown`.
6. If a session ID was returned before the ambiguous point, persist it with the creation request and use it only for reconciliation/status; do not resend the first prompt automatically.
7. Send a “created and started” acknowledgement only after the Host proves both session creation and first-prompt admission.
8. Map the acknowledgement Telegram message to the new dsh session so replying to that message targets the exact session.
9. If the session is busy/writer-held and no documented queue operation exists, report that status and do not enqueue implicitly.

### 6.8 Status

`/dsh_status` reports at least:

- Host endpoint reachability;
- Host/version contract fingerprint;
- observation capability;
- existing-session reply capability;
- project discovery;
- model discovery;
- session creation/first-prompt capability;
- last successful observation/reconnect time when available;
- degraded/error reason using redacted diagnostics.

A reachable Host alone never implies that every capability is available.

## 7. Host Connector Safety and Lifecycle

- Accept only the verified local transport. For TCP/HTTP-style endpoints, enforce loopback targets (`127.0.0.1` / `::1`) unless the verified Host contract uses a Unix socket. Do not accept arbitrary LAN/public endpoint configuration for this integration.
- Do not auto-scan arbitrary ports looking for a Host.
- Do not weaken dsh Host authentication, CORS/origin checks, or bind configuration.
- Use protocol clients/parameterized calls; do not construct shell command strings from Telegram text.
- Apply bounded timeouts and cancellation to health, discovery, read, and write calls. Write timeout handling must preserve the ambiguous-delivery rules above.
- Reconnect read-only observation with bounded exponential backoff and jitter. Do not replay side-effecting writes as part of reconnect.
- Redact secrets and session bodies from logs. Log stable hashes/IDs only when needed for correlation.
- Connector/observer shutdown must be bounded and independent from Codex shutdown; dsh shutdown failure must not prevent the existing Sea-Bridge cleanup path from running.

## 8. Delivery and Failure Semantics

dsh error mapping must distinguish at least:

- `host_unavailable`
- `contract_unsupported`
- `session_missing`
- `project_missing`
- `model_unavailable`
- `busy_or_writer_held`
- `validation_failed`
- `rejected`
- `delivery_unknown`
- `provider_error`

For prompt submission:

- **accepted** means the documented Host response proves admission;
- **observed/executed** is established later by durable session history/events;
- a successful HTTP/socket write alone does not imply prompt admission unless the Host contract defines it that way.

For an ambiguous result, persist `delivery_unknown`, notify the user not to repeat automatically, and rely on explicit reconciliation/manual confirmation before another write.

## 9. Testing and Acceptance

Automated tests must cover:

1. dsh Host connector contract/version detection and error mapping using sanitized fixtures;
2. per-capability gating when only some Host contracts are available;
3. incremental observation, first-start baseline, cursor/high-water persistence, reconnect, and notification deduplication;
4. the bridge-created-session race so the first created turn is not baselined away;
5. durable Telegram-send retry and atomic notification-message mapping;
6. exact dsh reply routing, exact Codex reply routing, provider collision detection, and preservation of current no-reply Codex routing;
7. dsh callback namespaces, opaque-token expiry/chat binding/single use, and callback payload length safety;
8. authorization and duplicate Telegram updates;
9. dsh reply delivery states including busy/writer-held and `delivery_unknown`;
10. creation-request crash windows: before Host call, after dispatch, after session ID return, after prompt admission, and before Telegram acknowledgement;
11. no automatic replay of ambiguous reply or creation requests;
12. project revalidation, duplicate names, stale/inaccessible projects, and project-scoped model rules when applicable;
13. model preference namespace isolation from Codex and stale-model handling;
14. additive database migration from a populated current-version Sea-Bridge database;
15. regressions: existing Codex notification, reply, direct no-reply input, `/new`, `/projects`, `/model`, and `/status` behavior remains unchanged;
16. dsh connector/observer failure does not prevent Telegram polling or Codex startup.

Target-Mac end-to-end acceptance must demonstrate:

1. an existing dsh Web session turn produces exactly one Telegram notification;
2. replying to that notification reaches that exact session in the active Web Host;
3. a Codex notification reply still reaches Codex and cannot cross-route to dsh;
4. plain text without reply preserves the current latest-Codex behavior and never targets dsh;
5. `/dsh_new` creates and starts a session under the selected project/model/default, and the first terminal event is not lost to startup baselining;
6. replying to the dsh creation acknowledgement or later dsh notification continues that exact dsh session;
7. Sea-Bridge restart does not replay baseline history or duplicate notifications/deliveries;
8. interruption at the tested creation crash windows does not produce automatic duplicate dsh sessions/prompts;
9. Host restart/reconnect recovers observation without replaying side-effecting writes;
10. Codex and dsh remain isolated and usable together.

Static tests alone do not establish live dsh Web Host behavior. Phase 0 and final target-Mac evidence must be reported separately.

## 10. Non-Goals

- dsh TUI integration or simultaneous TUI/Web control of the same session;
- remote approvals, interrupts, arbitrary shell execution, or web-profile administration from Telegram;
- modifying dsh session files/database directly;
- scraping browser credentials or process memory to obtain Host authentication;
- replacing or changing the existing Codex integration semantics;
- exposing the dsh Web Host to the LAN/public internet for Sea-Bridge connectivity;
- auto-retrying ambiguous side-effecting Host writes;
- guessing private Host endpoints or using UI automation as a protocol substitute.

# dsh Web Telegram Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dsh Web notifications, exact-session Telegram replies, and prefixed project/model/new-session commands without changing existing Codex behavior.

**Architecture:** First prove the active dsh Web Host contract on the target Mac. Add typed dsh-specific Host, state, observer, routing, and Telegram adapters; do not retrofit Codex tables or launch a second dsh writer. Gate each capability independently and persist all side-effecting delivery intent before calling the Host.

**Tech Stack:** Bun, TypeScript, bun:sqlite, existing Telegram Bot API client, the installed dsh Web Host contract proven in Task 0. Add no runtime dependency without explicit approval.

**Spec:** `docs/superpowers/specs/2026-09-30-dsh-web-telegram-bridge-design.md`

## Global Constraints

- The target is the dsh Web profile and its owning Host process; TUI is not a target in this scope.
- Existing Codex behavior and commands remain unchanged.
- No dsh operation silently reroutes to Codex or to another dsh session.
- No fallback may launch another dsh profile to resume or write a session.
- The change does not add provider semantics to existing Codex-specific persistence tables.
- dsh and Codex session mappings, cursors, and delivery idempotency remain provider-scoped.
- Direct dsh database/session-file mutation, private-endpoint guessing, UI automation, and starting another dsh writer are outside the fallback set.
- Do not auto-retry ambiguous side-effecting Host writes.
- Do not expose the dsh Web Host to the LAN/public internet for Sea-Bridge connectivity.
- No new dependencies without explicit approval; all new dsh capabilities are independently gated by observed Host contracts.

---

## File Map

| File | Responsibility |
|---|---|
| `docs/ai/2026-09-30-dsh-web-host-poc.md` | Sanitized version, transport, operation, event, and failure evidence from Task 0. |
| `poc/dsh-web-connector/` | Temporary in-profile Cordis connector source and `--patch` overlay; never installed into the permanent Web profile. |
| `src/dsh/types.ts` | dsh Web Host domain types and capability/result contracts derived from PoC evidence. |
| `src/dsh/web-host-client.ts` | Narrow client for only the Host operations proven and enabled by the PoC. |
| `src/dsh/capabilities.ts` | Independent runtime capability state and redacted status reasons. |
| `src/dsh/session-observer.ts` | Incremental dsh session/event observation and outbox enqueueing. |
| `src/dsh/notification-formatter.ts` | dsh-labeled redacted Telegram notifications with Telegram length limits. |
| `src/dsh/reply-router.ts` | Exact dsh session reply delivery and unknown/busy result mapping. |
| `src/dsh/new-session-manager.ts` | Project/model validation and durable dsh session creation orchestration. |
| `src/dsh/menu-ui.ts` | dsh project/model Telegram menus using opaque callback tokens. |
| `src/state/dsh-bridge-store.ts` | Provider-specific dsh schema operations, cursors, links, outbox, callbacks, and creation state. |
| `src/telegram/provider-reply-router.ts` | Exact provider selection for Telegram reply messages; preserves the existing Codex direct-text fallback. |
| `src/telegram/service.ts` | Prefixed command/callback integration and merged Bot command registration. |
| `src/main.ts` | Optional dsh connector/observer wiring and independent, fail-soft lifecycle. |
| `tests/dsh-web-host-client.test.ts` | Host transport fixtures, capability gating, and dsh error contract. |
| `tests/dsh-bridge-store.test.ts` | Additive schema, creation state transitions, opaque callbacks, and atomic outbox mappings. |
| `tests/dsh-session-observer.test.ts` | Baseline, incremental cursor, created-session race, reconnect, and event deduplication. |
| `tests/dsh-reply-router.test.ts` | Exact dsh replies, duplicate/unknown/busy outcomes, and provider isolation. |
| `tests/dsh-new-session-manager.test.ts` | Project/model checks, create idempotency, crash windows, and first-prompt admission. |
| `tests/dsh-telegram-service.test.ts` | `/dsh_*` command parsing, opaque callbacks, and Codex command regression coverage. |
| `tests/fixtures/dsh-web/README.md` and `tests/fixtures/dsh-web/*.json` | Sanitized Host contract and event fixtures only; the README records the verified version; no credentials or real session text. |

Task 0A is authorized only as a temporary, read-only in-profile connector PoC. It may stop/restart the currently verified Web Host with the same profile and startup arguments, using `dsh web --patch <absolute-poc-patch>` **only after all three preflight gates pass**: Node static import, clean temporary-profile overlay composition, and connector-specific schema/import diagnostics. It must not edit `~/.dsh/profiles/web`, install dependencies, read browser/dsh credentials, call write operations, or start a second Web Host on any port. If the original process cannot be safely restored, or a required Host contract cannot be verified, stop before disrupting it. If a capability cannot be proven, its production operation is omitted/disabled; dependent tasks test the disabled result rather than guessing a wire contract.

## Task 0: Prove the Active dsh Web Host Contract

**Files:**
- Create: `docs/ai/2026-09-30-dsh-web-host-poc.md`
- Create: `tests/fixtures/dsh-web/README.md` and sanitized contract/event fixtures only for interfaces proven in the PoC; record the verified dsh version in the README.

**Interfaces:**
- Produces the evidence needed to bind `DshWebHostClient` in Task 1.
- Reports these capability outcomes independently: `transport`, `observation`, `reply`, `projects`, `models`, and `creation`.

- [x] **Step 1: Record current local versions and process state.**

Run `dsh --version` and `dsh --help`. Inspect the active dsh Web process and its listening address using read-only process/socket inspection. Do not reuse a remembered port or endpoint. Do not print environment variables, browser storage, process memory, tokens, or session bodies.

Expected: version and active loopback/local endpoint evidence, or a clear `host_unavailable` result. If no Web Host is running, stop the PoC and request a user-approved test window; do not start a new dsh profile as an implicit fallback.

- [x] **Step 2: Locate only documented Host contracts.**

Inspect the installed dsh Web/API package documentation and the active profile's declared configuration with credential values omitted. Record the official method names, transport, authentication source, session identity, and version fingerprint. Do not probe arbitrary ports or guess private routes.

Expected: a local transport and supported auth mechanism can be described without scraping the browser or logs; otherwise `transport` remains unavailable.

- [x] **Step 3: Record external transport gate.**

The prior unauthenticated root request returned 401, and the installed client-connection documentation requires a browser session. Record external-process HTTP/API transport as unavailable; do not probe guessed endpoints or obtain browser credentials.

Expected: the plan does not treat a Host API's existence as proof of separate-process access; proceed to Task 0A using only the owning Host's in-process APIs.

- [ ] **Step 4: Exercise writes only in a user-designated test context.**

Before sending prompts or creating a session, obtain the exact test session/project and user confirmation in the implementation turn. Test one prompt to a live test session, one busy/writer-held case if safely reproducible, and one session creation plus first-prompt admission. Record whether the Host supports idempotency keys or reconciliation.

Expected: prove `reply` and `creation` separately. A timeout after dispatch is `delivery_unknown`; do not repeat the write to see whether it worked.

- [x] **Step 5: Write the PoC report and fixtures.**

Record dsh version, contract fingerprint, successful and unavailable capability gates, event examples with text removed, error categories, process lifecycle, and the exact verified operations. Add fixtures only after redacting tokens, paths that expose private user data, and session text.

Expected: report contains enough information to implement typed adapters without any speculative method, field, endpoint, or status mapping. `git diff --check` passes.

## Task 0A: In-Profile Read-Only Connector PoC

**Files:**
- Create: `poc/dsh-web-connector/index.mjs` — small ESM Cordis plugin loaded only for the PoC; no installed TypeScript loader assumed.
- Create: `poc/dsh-web-connector/package.json` — only `name`, `version`, `private`, and `type: module`; no dependencies or install.
- Create: `poc/dsh-web-connector/cordis.patch.yml` — temporary overlay that appends the connector to the active Web profile.
- Modify: `docs/ai/2026-09-30-dsh-web-host-poc.md` and `tests/fixtures/dsh-web/README.md` — record exact verified contracts and sanitized fixture shapes.

**Interfaces and safety boundary:**
- Call only documented in-process `ctx.sessionController` and `ctx.workspaceRegistry` APIs. Verify exact installed `0.1.7-rc.2` declarations/source before implementing any operation.
- Expose a fixed read-only RPC allowlist over a Unix domain socket under `~/.dsh/run/`; generate an independent short-lived token and store it in a file with mode `0600`, with restrictive socket/directory permissions. Sea-Bridge authenticates with that token. Never read or reuse browser cookies, launch tokens, `.credentials.yaml`, or profile secrets.
- No generic `call(method,args)` dispatch. Exclude settings, credentials, `openPath`, shell/command execution, `cancel`, `session.prompt`, `session.create`, and all writes.
- Allowlist only health, session list, history/page/follow, workspace/project list, and model catalog. Follow must have bounded lifetime, verified cursor semantics, and explicit disposal.
- Never log tokens, message bodies, credential/config values, or raw session/project identifiers. Use no new dependencies.
- Use `--patch` and temporary files only; never modify the permanent profile manifest, patch, package manifest, lockfile, or installed plugins.

- [x] **Step 1: Verify plugin insertion and exact in-process API contracts.** Read installed Cordis/Session Controller/Workspace declarations and active Web bundle composition. Confirm the overlay appends an absolute or patch-relative file entry without replacing any current row. If signatures or module resolution are unclear, stop without stopping the Host.
- [x] **Step 2: Build the temporary connector and focused contract tests.** Implement the health-only first mount with fixed read allowlist prepared but disabled until each subsequent gate passes. Use only Node built-ins, strict input/output validation, token comparison, socket permission checks, bounded operations, and graceful disposal. No Host operation runs at static import time.
- [x] **Step 2A: Run three preflight gates without touching the live Host.** (1) `node` static-imports `file://.../index.mjs` without calling `apply`; (2) create a temporary `DSH_HOME` using the shipped Web template and run `--patch <overlay> --dump-config`, redirecting the complete dump into temporary files and checking only the appended connector entry, source, and unchanged baseline count; (3) run `--dump-config-schema` in the same clean temporary profile and inspect connector-specific parse/module/schema diagnostics, not just the exit code. A config dump establishes composition only, **not** plugin import/mount. Never start the temporary profile as a Host, including on port 3081. Record and separate any pre-existing real-profile schema errors.
- [x] **Step 3: Verify and preserve the active Host launch state.** Confirm PID, executable, profile, exact non-secret startup arguments, listener ownership, and reproducible restart command. The LaunchAgent has an environment section but its values were not inspected. A private temporary plist copy changed only `ProgramArguments`; the original plist stayed byte-identical and supplied the same environment on re-bootstrap.
- [x] **Step 4: Restart only the verified Web Host with the temporary overlay.** The original LaunchAgent was booted out before its temporary same-label copy started; no second Host ran concurrently. The first runtime mount exposed only `health`, proving actual plugin activation, socket mode `0600`, and token file mode `0600`.
- [x] **Step 5: Exercise the read-only allowlist from Sea-Bridge.** Verified workspace list (2), session list (72), bounded follow opening snapshot and second opening snapshot after reconnect, history page at the snapshot's `throughSeq`, and model catalog (4 provider groups, no failures). The actual order is follow → page because the documented page contract needs the follow snapshot cursor. No message content, project path, raw ID, or credential was printed or returned by the probe. Post-snapshot live-event delivery and gap recovery remain unverified.
- [x] **Step 6: Restore the original Web Host and prove rollback.** The trial job was booted out and the original job was bootstrapped after each mount. The original plist remained byte-identical; Web again listens on `127.0.0.1:3080`, unauthenticated root returns 401, and PoC socket/token are absent.
- [x] **Step 7: Update Task 1 transport contract.** Sea-Bridge's read-only client uses the PoC-proven Unix socket + connector-owned ephemeral token, not browser-authenticated Web HTTP. `follow` provides an opening snapshot with numeric cursor; `page` requires numeric `throughSeq`. The PoC returns event identity/order metadata only, not notification text. Keep `reply` and `creation` disabled until a separately authorized write PoC.

## Task 1: Define dsh Domain Types, Capabilities, and Host Adapter

**Files:**
- Create: `src/dsh/types.ts`
- Create: `src/dsh/capabilities.ts`
- Create: `src/dsh/web-host-client.ts`
- Create: `tests/dsh-web-host-client.test.ts`
- Modify: `tests/fixtures/dsh-web/README.md` and add only the sanitized JSON fixtures recorded in Task 0.

**Interfaces:**
- `DshCapabilityName = "transport" | "observation" | "reply" | "projects" | "models" | "creation"`.
- `DshWebHostClient.health(): Promise<DshHostHealth>`.
- `DshWebHostClient.listSessions(): Promise<DshSessionSummary[]>`.
- `DshWebHostClient.followSnapshot(sessionId: string): Promise<DshFollowSnapshot>` exposes only the PoC-proven bounded opening snapshot and numeric cursor.
- `DshWebHostClient.pageHistory(sessionId: string, throughSeq: number, beforeSeq?: number): Promise<DshHistoryPage>` exposes metadata-only history paging using the PoC-proven numeric sequence contract.
- Do **not** expose a generic `readEvents(cursor)` or claim `continuity: "continuous" | "gap"` in Task 1. Live post-snapshot follow delivery and disconnect gap recovery remain unverified, so the `observation` capability is `partial` and Task 3 stays blocked on that evidence.
- `DshWebHostClient.listProjects(): Promise<DshProject[]>` and `listModels(): Promise<DshModelCatalog>` expose only the metadata-only shapes proven by Task 0A.
- Connector socket/token paths are explicit constructor inputs. The production adapter must not default to the temporary `sea-bridge-poc.*` paths, because those files are removed after the PoC.
- `submitPrompt` and `createSession` are absent/disabled until separately authorized and proven in a later write PoC. Task 0A must not define or exercise write transport.
- `DshWriteResult` is a discriminated union of `{ status: "accepted" }`, `{ status: "busy_or_writer_held" }`, `{ status: "rejected"; errorCode: string }`, and `{ status: "delivery_unknown"; errorCode: string }`. `DshCreateResult` includes `sessionId`, `turnId: string | null`, and `modelId: string | null` only when known.
- Unsupported operations return a typed `contract_unsupported` result; they do not use guessed URLs or subprocess fallbacks.

- [x] **Step 1: Add fixture-backed tests from the sanitized PoC contract.** Assert protocol 1, metadata shapes, numeric follow/page cursor handling, capability outcomes, token rotation, private runtime permissions, timeout handling, and connector error mapping. The fixture records the verified Host version `0.1.7-rc.2`; the runtime connector does not yet expose a separate safe Host-version RPC, so Task 1 does not fabricate one.
- [x] **Step 2: Run `bun test tests/dsh-web-host-client.test.ts`.** Result: 6/6 passed after correcting the fake connector's token-rotation behavior.
- [x] **Step 3: Add domain types and capability map.** `transport/projects/models` are contract-available, `observation` is explicitly `partial`, and `reply/creation` remain unavailable.
- [x] **Step 4: Implement only the proven transport.** The client performs one authenticated newline-delimited JSON request per private Unix-socket connection, reloads the connector-owned token per request, validates owner/private modes and response shapes, bounds response size/time, and exposes no prompt/create API.
- [x] **Step 5: Re-run focused and full tests.** `bun test tests/dsh-web-host-client.test.ts` passed 6/6 and full `bun test` passed 85/85. `bunx --no-install tsc --noEmit` reported no existing `tsc` binary; no dependency was installed and typecheck success is not claimed.
- [x] **Step 6: Commit** with `feat: add dsh web host adapter`.

## Task 2: Add Independent dsh Persistence and State Machines

**Files:**
- Modify: `src/state/db.ts`
- Create: `src/state/dsh-bridge-store.ts`
- Create: `tests/dsh-bridge-store.test.ts`

**Interfaces:**
- `DshBridgeStore` owns only dsh tables; existing `DesktopMessageStore` and Codex tables remain unchanged.
- `claimDelivery(updateId, replyToMessageId, sessionId, textHash)` is unique on Telegram update ID and returns `new | duplicate`.
- `beginCreation(updateId, projectId, modelId, promptHash)` persists `received` before Host effects.
- `transitionCreation(updateId, expectedStatus, nextStatus, detail)` uses a transaction/compare-and-set and refuses illegal transitions.
- `consumeCallback(token, chatId, now)` returns the stored action exactly once only for matching chat and unexpired state.
- `completeNotification(eventId, telegramMessageId)` transactionally stores the dsh mapping and marks the dsh outbox row sent.

- [x] **Step 1: Write migration and store tests.** The migration test now exercises a real on-disk upgrade path: seed current Codex rows, drop only the dsh tables to simulate the previous version, close the DB, reopen through `StateDb`, and prove all existing Codex rows/preferences remain identical while the new dsh tables start empty.
- [x] **Step 2: Add state-transition tests.** Coverage includes dsh delivery uniqueness; creation `received -> dispatching -> accepted -> acknowledged`; `dispatching -> delivery_unknown`; illegal transitions; namespaced `dsh.default_model`; callback chat binding/expiry/single-use; token-hash storage; atomic outbox-to-link completion including conflict rollback; created-session baseline marker; observer state; and pending-new-session prompt single consumption.
- [x] **Step 3: Run `bun test tests/dsh-bridge-store.test.ts`.** Result: 8/8 passed after the implementation.
- [x] **Step 4: Add dsh-only additive tables.** Added `dsh_message_links`, `dsh_deliveries`, `dsh_observer_state`, `dsh_notification_outbox`, `dsh_callback_tokens`, `dsh_creation_requests`, `dsh_created_sessions`, and `dsh_pending_new_session_prompts`; existing Codex tables are unchanged.
- [x] **Step 5: Implement typed store methods.** Callback secrets are stored only as SHA-256 hashes; creation transitions and callback consumption use transactions/CAS; notification completion uses a strict transaction so a message-link conflict rolls the outbox state back instead of silently losing the reply mapping. Raw prompts are not stored by Task 2.
- [x] **Step 6: Re-run migration/store and full regression tests.** Focused store tests passed 8/8 and full `bun test` passed 93/93. The new state modules pass a Bun build check and `git diff --check`. `bunx --no-install tsc --noEmit` still reports no existing `tsc` binary, so no typecheck success is claimed and no dependency was installed.
- [x] **Step 7: Commit** with `feat: add isolated dsh bridge state`.

## Task 3: Implement Incremental dsh Observation and Notification Outbox

> **Gate:** Task 0A proved only an opening follow snapshot plus history page/reconnect. Do not start production incremental observation until a read-only follow PoC proves post-snapshot live event delivery and a reconnect/gap-recovery rule. Until then, `observation=partial`.

**Files:**
- Create: `src/dsh/session-observer.ts`
- Create: `src/dsh/notification-formatter.ts`
- Create: `tests/dsh-session-observer.test.ts`
- Modify: `src/state/dsh-bridge-store.ts`
- Modify: `tests/dsh-bridge-store.test.ts`

**Interfaces:**
- `DshSessionObserver.start(): void`, `pollOnce(): Promise<void>`, and `stop(): Promise<void>`.
- `DshEventPage` carries `events`, `nextCursor`, and `continuity: "continuous" | "gap"`; the adapter derives `gap` from verified sequence evidence if the Host does not provide an explicit flag.
- `DshBridgeStore.saveObservationCursor(sessionId, cursor, contractFingerprint)` and `enqueueDshNotification(input)` are idempotent.
- `DshTelegramNotifier.sendMessage(chatId, text, buttons)` is injected, not constructed by the observer.

- [ ] **Step 1: Write observer tests with fixture-backed fake Host.** Cover first-start baseline, one new terminal event, repeated page, reconnect/resume cursor, missing/invalid event ID, provider-safe event fingerprint, and independent session cursors.
- [ ] **Step 2: Add race tests.** Register a Sea-Bridge-created session before advancing its observer baseline; complete the first turn before the next poll and assert the event enters the outbox exactly once.
- [ ] **Step 3: Run `bun test tests/dsh-session-observer.test.ts`.** Expected: failures for missing observer.
- [ ] **Step 4: Implement safe formatting.** Label source `dsh Web`, redact with existing `redact`, clamp to Telegram's supported message length, and omit final text when the verified event has none.
- [ ] **Step 5: Implement observer.** On ordinary existing sessions, baseline at the verified high-water mark; for created sessions, honor the durable creation marker. Persist cursor only after all page events have been enqueued. On continuity loss, re-open from a Host-supported cursor or mark observation degraded; never silently skip a gap.
- [ ] **Step 6: Implement outbox delivery.** Retry Telegram send failures with bounded backoff. After Telegram returns a message ID, atomically complete outbox and create the exact dsh message link. Use short opaque reply callback tokens; never embed a dsh ID in callback data.
- [ ] **Step 7: Re-run observer/store tests and `bun run typecheck`.** Expected: created first-turn race and reconnect cases pass.
- [ ] **Step 8: Commit** with `feat: observe dsh web session events`.

## Task 4: Route Telegram Replies by Exact Provider Mapping

**Files:**
- Create: `src/dsh/reply-router.ts`
- Create: `src/telegram/provider-reply-router.ts`
- Create: `tests/dsh-reply-router.test.ts`
- Modify: `src/telegram/service.ts`
- Modify: `tests/telegram-thread-reply-router.test.ts`

**Interfaces:**
- `DshReplyRouter.deliver(updateId: number, chatId: string, replyMessageId: number, text: string): Promise<DshReplyResult>`.
- `routeProviderReply(updateId: number, message: TelegramMessage, codexStore: DesktopMessageStore, dshStore: DshBridgeStore, codexQueue: Pick<ProcessCodexQueueClient, "queue">, dshRouter: DshReplyRouter): Promise<ProviderReplyResult>` resolves exactly one provider from exact `(chatId, replyMessageId)` links and dispatches only to that provider. `ProviderReplyResult` is `{ provider: "codex"; result: ThreadReplyRouteResult } | { provider: "dsh"; result: DshReplyResult } | { status: "unmapped_reply" | "provider_conflict" }`.
- A message without `reply_to_message` remains outside provider selection and follows current `routeThreadReply` Codex latest-link behavior unchanged.

- [ ] **Step 1: Add failing tests.** Verify dsh reply -> dsh Host only; Codex reply -> Codex queue only; missing mapping -> current unmapped response; simultaneous provider mapping -> invariant error and no dispatch; no-reply text -> latest Codex only; duplicate update -> no second Host call.
- [ ] **Step 2: Run `bun test tests/dsh-reply-router.test.ts tests/telegram-thread-reply-router.test.ts`.** Expected: provider router cases fail while all existing Codex cases pass.
- [ ] **Step 3: Implement dsh delivery CAS.** Persist `received` before Host call, transition to `dispatching`, then map Host accepted/rejected/busy/unknown to terminal store states. A process restart with `dispatching` becomes `delivery_unknown` unless the PoC-proven reconciliation operation resolves it.
- [ ] **Step 4: Implement exact provider precedence.** Look up both exact mappings; dispatch only when precisely one mapping exists. Collision is logged with no prompt content and no write occurs. Do not search dsh latest link for a plain text message.
- [ ] **Step 5: Wire dsh-specific delivery and safe user responses.** `busy_or_writer_held` states no implicit queue was used; `delivery_unknown` explicitly says not to resend until checked. No automatic replay.
- [ ] **Step 6: Re-run both router suites and `bun run typecheck`.** Expected: new provider routing tests and legacy direct Codex routing pass.
- [ ] **Step 7: Commit** with `feat: route telegram replies to dsh sessions`.

## Task 5: Implement dsh Project/Model Menus and Durable Session Creation

**Files:**
- Create: `src/dsh/new-session-manager.ts`
- Create: `src/dsh/menu-ui.ts`
- Create: `tests/dsh-new-session-manager.test.ts`
- Create: `tests/dsh-telegram-service.test.ts`
- Modify: `src/state/dsh-bridge-store.ts`
- Modify: `src/telegram/service.ts`

**Interfaces:**
- `DshNewSessionManager.listProjects(forceRefresh?: boolean): Promise<DshProject[]>`.
- `DshNewSessionManager.listModels(projectId: string | null, forceRefresh?: boolean): Promise<DshModel[]>`.
- `DshNewSessionManager.setDefaultModel(chatId: string, modelId: string | null): void` stores only `dsh.default_model`.
- `DshNewSessionManager.create(updateId: number, chatId: string, projectId: string, modelId: string | null, prompt: string): Promise<DshCreateOutcome>`.
- `DshMenuUi` emits short callback tokens; token rows on the server bind chat, action, Host IDs, expiry, and single-use state.

- [ ] **Step 1: Add failing project/model tests.** Cover duplicate names, unavailable/stale projects, revalidation on callback, model list unavailable, stale saved model, Host-default selection, and preference isolation from Codex `default_model`.
- [ ] **Step 2: Add creation crash-window tests.** Simulate failure before Host dispatch, transport loss after dispatch, session ID returned before prompt acceptance, accepted prompt before Telegram acknowledgement, and first turn completion before next observer poll. Assert no ambiguous operation is automatically repeated.
- [ ] **Step 3: Add callback tests.** Assert every callback payload stays within Telegram's callback-data limit and raw project/model/session IDs never appear in the payload. Cover wrong chat, expired token, consumed token, and duplicate taps.
- [ ] **Step 4: Run `bun test tests/dsh-new-session-manager.test.ts tests/dsh-telegram-service.test.ts`.** Expected: failures for the new manager and commands.
- [ ] **Step 5: Implement prefixed command handlers.** Add `/dsh_projects`, `/dsh_model`, `/dsh_new`, and `/dsh_status` parsing without changing `/projects`, `/model`, `/new`, or `/status`. Initially `/dsh_model` is catalog-only/read-only and new sessions follow the Host default. Keep `/dsh_new` unavailable until separate write-PoC authorization proves create + first-prompt semantics, including whether model selection can avoid changing the Web global default.
- [ ] **Step 6: Implement state-aware creation recovery.** On Sea-Bridge restart, convert unresolved `dispatching` creation writes to `delivery_unknown` unless the PoC-proven reconciliation operation resolves them. Never replay create or first prompt automatically. Acknowledge only after both create and prompt admission are confirmed.
- [ ] **Step 7: Implement dsh opaque callback flows.** Use server-side rows for project/model selection and callback actions; revalidate Host identity/model/project at action time. Callback handling is bound to chat and single-use for writes.
- [ ] **Step 8: Re-run focused tests and `bun run typecheck`.** Expected: all prefixed-command, model namespace, token safety, and crash-window tests pass.
- [ ] **Step 9: Commit** with `feat: add dsh telegram session creation`.

## Task 6: Wire Fail-Soft Startup, Status, and Command Registration

**Files:**
- Modify: `src/main.ts`
- Modify: `src/telegram/service.ts`
- Modify: `src/config.ts` only if the verified transport requires a non-secret local endpoint setting.
- Modify: `tests/dsh-telegram-service.test.ts`
- Create: `tests/dsh-lifecycle.test.ts`

**Interfaces:**
- Optional dsh composition injects `DshWebHostClient`, `DshBridgeStore`, `DshReplyRouter`, `DshNewSessionManager`, and `DshSessionObserver` into `TelegramService`.
- `DshSessionObserver.stop()` is bounded and idempotent; observer failure cannot reject dsh-independent startup or Telegram polling.
- `getDshStatus()` reports Host and each capability independently with redacted reasons.

- [ ] **Step 1: Add failing lifecycle tests.** Simulate connector construction failure, Host offline, observation poll failure, reconnect, observer stop timeout, and command sync. Assert Telegram polling and Codex adapters remain active.
- [ ] **Step 2: Run the targeted service/startup tests and confirm the new cases fail.** Existing tests must pass before wiring.
- [ ] **Step 3: Wire optional components.** Seed stable capability names without overwriting observed per-capability state at every boot. Start and stop the dsh observer independently; catch/log dsh teardown errors while continuing Codex and DB cleanup.
- [ ] **Step 4: Merge Telegram commands.** Register the existing Codex commands plus the four `/dsh_*` commands as one set. dsh runtime outage must not remove either set. Keep unknown-command help accurate by provider.
- [ ] **Step 5: Implement `/dsh_status`.** Report verified Host version/fingerprint, per-capability status, last successful poll/reconnect, and redacted reason; do not report host reachable as all capabilities available.
- [ ] **Step 6: Re-run focused lifecycle/service tests and `bun run typecheck`.** Expected: dsh failures are fail-soft and Codex service behavior is unchanged.
- [ ] **Step 7: Commit** with `feat: wire dsh bridge lifecycle and status`.

## Task 7: Full Regression and Target-Mac Acceptance

**Files:**
- Modify: `tests/dsh-web-host-client.test.ts`, `tests/dsh-bridge-store.test.ts`, `tests/dsh-session-observer.test.ts`, `tests/dsh-reply-router.test.ts`, `tests/dsh-new-session-manager.test.ts`, `tests/dsh-telegram-service.test.ts`, and `tests/dsh-lifecycle.test.ts` only to close acceptance gaps; no unrelated refactors.
- Update: `docs/ai/2026-09-30-dsh-web-host-poc.md` with final sanitized acceptance outcomes.

**Interfaces:**
- The complete dsh bridge exposes only PoC-verified capabilities.
- Existing Codex provider behavior remains byte/row-compatible and behaviorally unchanged.

- [ ] **Step 1: Run formatting/diff checks.** Run `git diff --check`.
- [ ] **Step 2: Run the complete automated suite.** Run `bun test`. Expected: every existing and new test passes; if a failure is unrelated, report the failing scope and do not claim full success.
- [ ] **Step 3: Run strict type validation and build.** Run `bun run typecheck` and `bun run build`.
- [ ] **Step 4: Verify migration from populated state.** Use a temporary copied test DB fixture with Codex rows and preferences; run the migration and assert Codex links/deliveries/outbox/preferences and commands retain prior semantics.
- [ ] **Step 5: Run target-Mac E2E with the user-designated dsh test project/session.** Verify existing-session notification/reply, dsh new-session/project/model flow, exact reply, callback safety, created-first-turn observation, connector reconnect, and no-replay behavior after each agreed crash window. Do not use a personal production task/session unless the user designates it.
- [ ] **Step 6: Verify Codex coexistence.** Exercise mapped Codex reply and no-reply direct text; assert they still target Codex and never dsh. Verify `/status`, `/projects`, `/model`, `/new` and existing notification behavior.
- [ ] **Step 7: Record acceptance boundaries.** Separate automated test results, Host PoC evidence, and live E2E results. Mark each unproven dsh capability unavailable; do not claim global success if any required gate failed.
- [ ] **Step 8: Commit** with `test: verify dsh and codex bridge coexistence`.

## Self-Review Coverage

| Spec requirement | Plan task |
|---|---|
| Target-Mac dsh Host transport and independent capability gates | Task 0, Task 1 |
| dsh-only additive state and migration compatibility | Task 2 |
| Observation baseline, cursor, reconnect, event deduplication | Task 3 |
| Created-session first-turn race | Task 2, Task 3, Task 5, Task 7 |
| Atomic Telegram outbox/link and safe retry | Task 2, Task 3 |
| Exact provider routing and unchanged Codex no-reply semantics | Task 4, Task 7 |
| Opaque callback tokens and callback expiry/chat/single-use checks | Task 2, Task 3, Task 5 |
| Durable new-session intent and all ambiguous crash windows | Task 2, Task 5 |
| Project/model validation and preference namespace | Task 5 |
| Fail-soft lifecycle, status, command merge | Task 6 |
| Secret/session-text redaction, loopback-only access, no private guessing | Tasks 0-1 and Global Constraints |
| Full tests/typecheck/build and target-Mac boundary reporting | Task 7 |

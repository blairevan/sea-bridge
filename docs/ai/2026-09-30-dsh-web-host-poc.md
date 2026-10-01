# dsh Web Host PoC

- Date: 2026-09-30
- Installed dsh CLI: `0.1.7-rc.2`
- Scope: read-only discovery; no session prompt, session creation, profile edit, or credential read was performed.

## Evidence

1. `dsh --version` returned `0.1.7-rc.2`; `dsh --help` identifies `web` as a profile entry mode and exposes no standalone session-control command.
2. A local listener was present at `127.0.0.1:3080`. A bounded, body-discarding `GET /` without browser credentials returned HTTP `401`. This is consistent with the installed Web client-connection documentation; the listener was not otherwise modified or restarted.
3. Installed `@deepseek-ai/dsh-client-connection` documentation states that each Host RPC method and WebSocket stream requires a browser session; there is no method-specific loopback tier. Its documented browser flow exchanges a launch token at the root for an authority-bound signed cookie. It states that the HTTP carrier does not accept an Authorization-header token.
4. Installed `@deepseek-ai/dsh-api-session-controller` documentation describes Host session lifecycle, prompt, history, and follow operations through API Gateway. `@deepseek-ai/dsh-api-gateway` documents generated Client Remote calls and authenticated HTTP/WebSocket carriers. These establish that Host-side operations exist, but not a supported credential path for a separate Sea-Bridge process.
5. Installed `@deepseek-ai/dsh-session-persistence-jsonl` documentation describes durable per-session event logs, compressed by default, and one live writer per session enforced across processes. This confirms that direct file mutation or a second writer is not a safe bridge.

## Capability Results

| Capability | Result | Evidence boundary |
|---|---|---|
| Local Web listener | Observed | Loopback listener and unauthenticated root response; no Host API call was made. |
| Separate-process transport/auth | **Not passed** | Browser-session authentication is documented; no supported Sea-Bridge credential/client entry was found. Do not extract launch tokens, browser cookies, process memory, or credential records. |
| Session observation | **Unavailable to Sea-Bridge** | Host APIs document history/follow, but no independently authenticated caller was verified. |
| Reply to existing session | **Unavailable to Sea-Bridge** | No prompt was sent. Host API presence is not evidence that a separate caller can safely invoke it. |
| Project discovery | **Unverified** | No authenticated project-list request or stable project contract was verified. |
| Model discovery | **Unavailable to Sea-Bridge** | A Host model catalog is documented, but no authenticated request was made. |
| Session creation | **Unavailable to Sea-Bridge** | No session was created; no target project or test session was designated for write PoC. |

No sanitized event/request fixtures were captured because no authenticated Host operation was performed. No session content, credential value, browser data, or process token was read or recorded.

## Decision and next gate

The Sea-Bridge-only connector gate is blocked at external-process authentication. Do not implement a guessed private endpoint, scrape browser/process credentials, expose the Web Host beyond loopback, or start another dsh writer.

The user authorized a separate Task 0A: a temporary, read-only in-profile connector loaded with `dsh web --patch <poc-patch>`. This does not authorize permanent profile edits, credential access, prompt submission, or session creation. The connector must use a fixed allowlist over a local Unix socket and its own short-lived 0600 token. It may call only verified in-process session/workspace read APIs. A second authorization is required before any prompt/create write test.

At the initial checkpoint PID 3794 ran Node with `dsh web --no-open --port 3080 --host 127.0.0.1` and owned the loopback listener. The installed CLI is `0.1.7-rc.2`; top-level `dsh --help` documents repeatable `--patch` overlays. The later temporary runtime mounts restarted the same LaunchAgent and changed the PID; the original profile files and LaunchAgent plist were not modified.

The installed Session Controller declarations are available from the dsh CLI's bundled `node_modules`, not the Web profile's visible `node_modules`. Verified read-only Host methods include `sessionController.list(request, signal)`, `modelCatalog()`, `page(request, signal)`, and `follow(request, signal)`; `WorkspaceRegistry.list()` synchronously returns workspace entities (`id`, `title`, `path`, `sessionIds`, timestamps). The API types define `SessionPageRequest.address` as an ordinary session or direct subagent address, and `SessionFollowRequest` carries that address plus optional bounded history-window settings. The connector must project workspace fields to a minimum safe shape and must not expose filesystem paths by default. Session summaries may include cwd and projections, so the connector must project those too rather than forwarding Host objects wholesale.

`dsh --profile web --dump-config-schema` emitted existing plugin/schema load errors. This is not proof that the temporary overlay fails. Task 0A preflight therefore used a separate `DSH_HOME` and the shipped Web template without launching a second Host:

| Gate | Result | Boundary |
|---|---|---|
| Node import | Passed | Current Node parsed/imported `index.mjs`; `apply()` was not called. |
| Overlay composition | Passed | `--dump-config` baseline had 182 entries; adding the PoC patch produced 183, with only the appended `file:` connector entry. This does **not** prove import or mount. |
| Schema/import diagnostics | No connector-specific error | Both clean temporary-profile schema runs exited 1 with identical two warnings and four pre-existing Loader tree-carrier errors; PoC entry had `status: absent` because no config schema is declared. This does **not** prove runtime mount. |
| Isolated health-socket unit test | Passed | `node --test poc/dsh-web-connector/index.test.mjs` proved authenticated health, rejection of `session.prompt`, private directory/socket/token modes, and disposal cleanup with a fake Cordis context. No real Host service was used. |

## Task 0A runtime acceptance and rollback

With the user's explicit approval, a private temporary copy of LaunchAgent `com.deepseek.dsh` changed only `ProgramArguments` to put `--patch <overlay>` before the Web app flags; it retained the original environment without inspecting its credential values. The original job was booted out before the temporary same-label job bootstrapped; no second Web Host or session writer was launched. An exit trap booted out the temporary job and bootstrapped the original plist even on PoC failure. No permanent profile or original LaunchAgent plist was edited.

| Read capability | Observed result | Boundary |
|---|---|---|
| Transport/auth/health | Passed | Actual Cordis mount answered an authenticated Unix-socket health request. Private run directory, socket, and generated per-mount token file had no group/other access; the token was never printed. |
| Projects | Passed | `ctx.workspaceRegistry.list()` returned 2 registered workspaces through a metadata-only projection (`id`, `title`, `sessionCount`); no `path` crossed the connector. |
| Sessions | Passed | `ctx.sessionController.list({}, signal)` returned 72 visible sessions through a metadata-only projection; no `cwd` or projections crossed the connector. |
| Follow/history | Partially passed | A bounded `follow({ address, maxMessages: 1 }, signal)` returned an opening snapshot. A second independent connection returned a snapshot with a nondecreasing numeric cursor. Post-snapshot live event delivery and gap recovery were **not** verified. |
| Page | Passed for one existing session | `page({ address, throughSeq: followCursor, maxMessages: 1 }, signal)` returned a page. The actual order is follow → page because `throughSeq` comes from the opening snapshot. Only event type/seq/time metadata crossed the connector, not `event.data`. |
| Models | Passed | `modelCatalog()` returned 4 provider groups, 0 isolated failures; only provider/model identity and count were projected, not failure messages or credential/config state. |
| Reply and creation | Not attempted; disabled | No prompt, create, model selection, or session write was called. Separate authorization with a designated test context is still required. |

After each mount, the temporary job was removed and the original job restored. Final check: LaunchAgent PID 18806 again listens at `127.0.0.1:3080`, unauthenticated `GET /` returns 401, the original plist matches its private backup byte-for-byte, and the PoC socket/token are absent. The static/isolated Node tests passed (2 tests); the final `bun test` passed (79 tests, 0 failures); `node --check` for PoC modules, `bash -n` for the rollback script, fixture JSON parse, and `git diff --check` passed. `bun run typecheck` previously entered `bunx` dependency resolution because this worktree has no local TypeScript installation; it was interrupted without installing a dependency. No typecheck success is claimed.

After confirming restoration, the exact private temporary LaunchAgent copies (which may have contained inherited environment values) and the clean-profile dump directory were removed. They were temporary PoC artifacts and are not recoverable; the committed/planned PoC source and original LaunchAgent/profile remain intact. The rollback script requires a new, validated private trial directory if rerun.

Only the PoC's local, read-only transport is proven. The connector is not permanently installed, and production observation/Telegram notification formatting remains outside this acceptance; in particular event text was deliberately not exposed. No credential, browser session, raw session body, real ID, or workspace path was included in the probe output or fixture.


## Task 1 read-only adapter implementation

Task 1 now implements the Sea-Bridge side of the PoC-proven read transport in `src/dsh/` without wiring it into `main.ts` or making the temporary connector permanent.

- `DshWebHostClient` uses the authenticated Unix-socket protocol proven in Task 0A and accepts explicit socket/token paths; it does not guess the deleted PoC runtime files.
- The token is re-read for every request so a connector remount/token rotation does not require rebuilding the client. Runtime directory, socket, and token ownership/private mode are checked before transport use.
- Responses are size/time bounded and validated into metadata-only domain types. Raw Host objects, cwd/path/projections, event bodies, credentials, and token values are not exposed or logged.
- The client exposes only `health`, project/session list, bounded opening `followSnapshot`, history `pageHistory`, and model catalog. There is no prompt/create transport and no generic RPC method.
- Capability evidence is explicit: `transport/projects/models=available`, `observation=partial`, and `reply/creation=unavailable`. The later bounded live PoC below establishes a narrow live/reconnect rule, but the production client still exposes only opening snapshots and pages; it cannot yet claim continuous observation.
- The fixture records the verified dsh Host version `0.1.7-rc.2`, while connector protocol `1` is the runtime contract checked by the client. The current connector has no separate safe Host-version RPC, so the adapter does not invent a runtime version value.

Verification after implementation: focused `bun test tests/dsh-web-host-client.test.ts` passed 6/6 and full `bun test` passed 85/85. A Bun build check of the new dsh modules succeeded, the existing PoC Node tests still pass 2/2, and `git diff --check` passes. `bunx --no-install tsc --noEmit` confirmed that no local/cached `tsc` binary is present; it did not install anything, so TypeScript typecheck success is not claimed.


## Task 2 isolated dsh state implementation

Task 2 adds only provider-specific dsh persistence and does not wire any new Host write path or production observer.

- `StateDb` creates eight additive dsh tables for exact Telegram links, reply deliveries, observer high-water state, notification outbox, callback-token state, creation requests, created-session baseline markers, and pending new-session prompts. No provider column or semantic change was added to existing Codex tables.
- Upgrade verification uses an on-disk database populated with representative existing Codex links, deliveries, observer cursor, notification outbox, `default_model`, and pending-new-thread prompt. After removing only the dsh tables to simulate the pre-feature database and reopening through `StateDb`, every existing Codex row remains unchanged and the dsh tables are recreated empty.
- Telegram update IDs are the dsh delivery/creation idempotency keys. Creation transitions are compare-and-set and permit the designed `received -> dispatching -> accepted -> acknowledged` path plus explicit `delivery_unknown`; illegal or stale transitions do not advance state.
- dsh model preference uses only the shared `user_preferences` key `dsh.default_model`, leaving Codex `default_model` untouched.
- Opaque callback tokens are never stored raw. The local state keeps a SHA-256 token hash, chat binding, action/payload, expiry, and single-use status. Wrong-chat and already-consumed tokens do not change state; expired tokens become expired without producing an action.
- Notification completion creates the exact dsh Telegram-message mapping and marks the outbox row sent in one SQLite transaction. Mapping conflicts throw and roll the transaction back, preserving the pending outbox row for diagnosis/retry rather than silently losing reply routing.
- Created-session markers retain a one-time `baseline_pending` bit for the future first-turn race handling. Observer state storage exists; the later read-only PoC below narrows the Task 3 gate without implementing the observer.
- No raw dsh prompt is persisted by Task 2; current creation state stores the prompt hash only.

Verification: `bun test tests/dsh-bridge-store.test.ts` passed 8/8, full `bun test` passed 93/93, the new state modules passed a Bun build check, and `git diff --check` passed. `bunx --no-install tsc --noEmit` still finds no existing `tsc` binary, so typecheck success is not claimed and no dependency was installed.

## Task 3 prerequisite: bounded live follow and reconnect PoC

On installed dsh `0.1.7-rc.2`, the read-only in-profile connector gained a bounded `history.followWindow` operation. It returns only the opening cursor and optional next event's type/sequence/time, never the event body. A separate pure recovery probe walks `history.page` backwards from a fresh snapshot cursor to an older cursor, requiring strictly contiguous sequences; its experimental bounds are 32 sequences and eight pages. Missing, truncated, or out-of-order pages fail closed.

Preflight revalidated static Node import, clean temporary-profile overlay composition and connector-specific schema diagnostics without starting another Host. After temporarily mounting the overlay on the same Web LaunchAgent, the probe observed one organically arriving post-snapshot event with sequence `cursor + 1`. A new follow connection opened at a cursor at least as high; the old-to-new one-sequence interval was recovered by a page. Separately, a simulated historical gap of 12 existing sequences was recovered across three pages. The event's origin is unknown, and neither a real multi-event disconnect nor every reconnect error mode was exercised. The installed Host source has no follow-resume cursor argument: reconnect must take a fresh opening snapshot and page back to the durable old cursor. Never advance that cursor over an unverified gap.

The trial Host was removed and the original same-label LaunchAgent restored; its plist remained byte-identical, it again served `127.0.0.1:3080` (unauthenticated root returned 401), and the PoC socket/token were absent. No prompt, session creation, browser credential access, permanent profile change, or second Host occurred. This evidence permits designing Task 3's observer and streaming adapter, but `observation=partial` until production end-to-end verification; the Task 1 client does not yet support a continuous stream.

## Task 3 terminal-metadata follow-up

With separate approval, the same temporary-overlay/rollback procedure mounted a read-only projection of `turn/end`'s `data.reason.kind`. The connector returns only a fixed reason-category string, replacing unrecognized values with `unknown`; it does not return the rest of `data`, failure detail, or message text. A bounded probe scanned 30 existing sessions and found two `turn/end` records, both `completed`. This verifies `completed` on the installed Host; `error`, `aborted`, and other terminal categories were **not** observed live and must not yet be asserted as verified notification outcomes. No new turn was induced by this probe.

The original LaunchAgent plist remained byte-identical and was restored on `127.0.0.1:3080`; the temporary connector socket/token and private plist copies were removed. The production client now validates the optional category, and a bounded, fail-closed metadata recovery helper has dedicated tests. Neither notifications nor a production observer are enabled; chat selection, session title, terminal text, and end-to-end event delivery still require contract work.

After the user chose a shared Telegram destination, Task 3's isolated observer accepts the existing `config.allowedChatId` by injection, and formats only the verified `completed` category with a generic title when no verified Host title is available. It atomically persists an exact cursor and deduplicated outbox intent, retains the first created-session event, and fails closed on gaps or unverified terminal categories. It can deliver pending rows through an injected Telegram client in tests; it is **not wired into the running service**, so no live dsh notifications are enabled yet. Live streaming and non-completed outcome coverage remain pending.

The production read client now implements the bounded `history.followWindow` metadata RPC with a dedicated longer deadline and contiguous-sequence validation; it still does not claim a long-lived continuous stream. Outbox delivery automatically retries only an explicit Telegram 429 rejection. A transport error of unknown admission status, or a returned Telegram message ID whose exact reply mapping could not be committed, remains pending but is quarantined from automatic replay for reconciliation. No unsupported automatic resend or duplicate-send guarantee is claimed. This remains isolated code and tests; permanent Host connector installation and runtime notification enablement were not authorized by the read-only PoC.

The observer also rejects incomplete session listings instead of silently omitting sessions beyond the connector's current 200-item projection. Its SQLite cursor/outbox transaction rechecks a created-session marker at commit time so a marker appearing during the opening snapshot cannot be baselined away. Neither guard claims that the current connector supports paginating more than 200 sessions; that Host contract remains a production gate.

## Read-only connector installation and rollback

With separate user approval, the connector's fixed read-only source was snapshotted into `~/.dsh/connectors/sea-bridge/` (`index.mjs`, `read-operations.mjs`, `package.json`, `cordis.patch.yml`) under a private directory with mode `0600` files. Its plugin identity and runtime socket/token were promoted from the earlier PoC names to `sea-bridge-dsh-web-connector` and `~/.dsh/run/sea-bridge.{sock,token}`. No new Host write operation, credential read, browser API, or generic RPC was added. The installed files are independent of this temporary feature worktree.

Preflight static import and clean temporary-profile overlay composition passed. The clean-profile baseline and overlay schema diagnostics were identical; both schema commands exited 1 on pre-existing diagnostics, so this was not counted as runtime proof. A short same-label LaunchAgent trial mounted the **installed snapshot** and verified health, projects, sessions, snapshot/reconnect/page, and models, then restored the original job. After preserving the original LaunchAgent plist byte-for-byte in `~/.dsh/backups/sea-bridge-20260930/original.plist` (private mode), the original same-label job was restarted with `--patch ~/.dsh/connectors/sea-bridge/cordis.patch.yml` before Web flags. Runtime checks found 72 sessions, two projects, four model groups, private `0700` runtime/install directories and `0600` socket/token files, and `127.0.0.1:3080` still owned by the Web Host. The Sea-Bridge production read client authenticated over this socket and completed health/list/follow/page/catalog reads. The temporary trial plists and clean-profile dump were deleted; the private original plist backup was deliberately retained for rollback.

A read-only end-to-end acceptance probe used the installed Host connector, a separate in-memory Sea-Bridge database, and a **fake** Telegram sender. It recovered one verified historical completion, committed the observer cursor/outbox and exact fake message link, and sent no real Telegram message. This verifies the connector-to-observer shape, not runtime Telegram delivery, real concurrent turns, or write capabilities. The production Sea-Bridge entrypoint still does not start the dsh observer; reply/callback handling is not ready, so activating real notifications would create unusable buttons.

To roll back this connector installation, stop only the `com.deepseek.dsh` LaunchAgent, restore its plist from the private backup above, then bootstrap the same label and verify `127.0.0.1:3080` responds while the connector socket/token disappear. Do not remove the installed snapshot or backup until the original Host has been verified healthy. No permanent Web profile file was edited.

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.deepseek.dsh.plist"
cp "$HOME/.dsh/backups/sea-bridge-20260930/original.plist" "$HOME/Library/LaunchAgents/com.deepseek.dsh.plist"
chmod 600 "$HOME/Library/LaunchAgents/com.deepseek.dsh.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.deepseek.dsh.plist"
```

The backup contains the original LaunchAgent environment and is private; never print or attach its contents. The rollback was not executed after permanent activation because the approved installed read-only Host is healthy.


## Post-install review before runtime wiring

A follow-up review found three issues that matter only after promoting the connector from PoC to a permanent Host component:

1. The isolated observer was generating a `dsh:reply:<token>` button even though Telegram-side dsh callback/write routing is not implemented. The tracked observer now sends completion notifications without any reply button while `reply=unavailable`; it also creates no unused dsh callback token for those read-only notifications.
2. `DshSessionObserver.stop()` previously cleared its interval but did not wait for an active poll. The tracked Host client now accepts an external `AbortSignal`; observer shutdown aborts the current Host request and waits for the poll to unwind. Telegram admission is also bounded/cancellable, and an interrupted or timed-out send is quarantined as delivery-unknown rather than replayed.
3. The permanent connector retained the PoC-era "runtime path must be absent" rule. A crash or unclean shutdown could leave a private socket/token behind and prevent future mounts. The tracked connector now validates owner/type/mode, refuses to replace a live connector socket, and removes only owner-private stale connector runtime files. Unit tests cover stale-token recovery and active-socket protection.

At this earlier read-only review checkpoint, these changes existed only in the feature worktree. They did **not** automatically modify the then-installed snapshot under `~/.dsh/connectors/sea-bridge/`; an explicit install and controlled Web Host restart were still required. The later 0.4.0 deployment is recorded below.

Verification after this review: `node --test poc/dsh-web-connector/index.test.mjs` passed 6/6; focused dsh observer/client tests passed; full `bun test` passed 116/116; `./node_modules/.bin/tsc --noEmit`, `bun run build`, and `git diff --check` passed. No real Telegram message, prompt, session creation, connector reinstall, or Host restart was performed during this review.


## Read-only runtime wiring and connector update path

At this earlier checkpoint, the feature worktree contained the production-side read-only wiring, while live dsh writes remained disabled. The later full-mode deployment is recorded below.

- The tracked connector is versioned as `0.2.0`. Its health response includes `connectorVersion` in addition to protocol `1`; `DshWebHostClient` rejects a stale/incompatible runtime fingerprint. Project, session, model-group, and model projections also fail closed when a bounded connector projection would be incomplete.
- `scripts/install-dsh-read-connector.sh` is the repeatable snapshot install/check path. It copies only `index.mjs`, `read-operations.mjs`, `package.json`, and `cordis.patch.yml` into a private `~/.dsh/connectors/sea-bridge/` snapshot, verifies hashes and modes, atomically restores the previous snapshot on verification failure, and never restarts the Host itself. A temporary `DSH_HOME` acceptance proved install -> check and intentional drift detection.
- The connector mount now recovers only owner-private stale `sea-bridge.sock` / `sea-bridge.token` files left by an unclean exit. It refuses a live connector socket, wrong file type, broad permissions, or wrong ownership.
- `DshWebHostClient` supports external cancellation. `DshSessionObserver.stop()` aborts an active Host read and waits for the current poll to unwind before shared SQLite state can be closed. Telegram send admission is bounded; timeout/cancellation remains quarantined as delivery-unknown rather than automatically replayed.
- `src/main.ts` composes the dsh read path only when `SEA_BRIDGE_DSH_READ_ONLY_ENABLED=true`. Runtime failure is fail-soft and does not block Codex or Telegram polling. Real dsh notification polling requires the separate `SEA_BRIDGE_DSH_NOTIFICATIONS_ENABLED=true` switch, defaults off, and starts only after connector health/version validation succeeds. `SEA_BRIDGE_DSH_SOCKET_PATH`, `SEA_BRIDGE_DSH_TOKEN_PATH`, and `SEA_BRIDGE_DSH_POLL_INTERVAL_MS` remain independently configurable.
- `/dsh_status`, `/dsh_projects`, and `/dsh_model` are available through a narrow read-only Telegram facade. `/dsh_model` is catalog-only and exposes no mutation callback. Read-only dsh completion notifications no longer render a reply button or allocate a callback token.
- A manual Telegram reply to an exact dsh notification mapping is recognized and explicitly blocked with a read-only message; nothing is sent to dsh. A simultaneous Codex+dsh exact mapping is treated as an invariant conflict and dispatches to neither provider. Plain text without a reply target still follows the pre-existing latest-Codex behavior.
- The installed connector snapshot under `~/.dsh/connectors/sea-bridge/` was **not** modified by this implementation turn, the dsh Web Host was **not** restarted, and no real Telegram message, prompt, or session creation was performed. The currently running installed snapshot must be explicitly updated and restarted/revalidated before connector `0.2.0` behavior is considered live.

Verification after this implementation: full `bun test` passed 122/122 with 403 expectations; `./node_modules/.bin/tsc --noEmit`, `bun run build`, `git diff --check`, JSON parsing, connector Node tests, and temporary installer acceptance all passed.

## Full bridge implementation (connector 0.4.0)

The read-only stage above is retained as historical evidence. This section records the complete Telegram bridge implementation at its code-completion checkpoint; the later target-Mac deployment and live acceptance are recorded at the end of this document.

The exact dsh write API was verified against upstream tag `dsh-v0.1.7-rc.2` before implementation:

- `sessionController.create({ workspaceId, sessionId })` accepts an explicit session ID and adopts an already persisted session when the workspace/cwd matches. Sea-Bridge therefore uses a deterministic hashed `session-sea-bridge-<24 hex>` ID derived from Telegram chat/update identity.
- `sessionController.prompt({ requestId, sessionId, mode: "queue", content })` deduplicates an already recorded `requestId`. Existing-session replies use `sea-bridge-tg-<updateId>`; first prompts use `sea-bridge-new-<updateId>`.
- `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })` returns the effective selection. In dsh `0.1.7-rc.2` it also persists the selection as the Host default asynchronously, so the Telegram model menu warns that later Web sessions may inherit the changed default.
- Explicit `session/agent-busy` and `session/writer-held` outcomes are surfaced. Unknown transport/Host outcomes become `delivery_unknown`; Sea-Bridge never automatically replays them.

Connector `0.4.0` exposes only a fixed local Unix-socket allowlist: health/project/session/history/model reads, the narrow `turn.summary` terminal-text projection, plus `prompt.submit`, `session.create`, and `session.selectModel`. General history remains metadata-only. `sessions.list` may expose only the durable title projection; `turn.summary` may expose only the last non-empty committed assistant `text` blocks for the exact terminal turn. Reasoning, tool-call arguments, paths, files/images, and arbitrary event data remain private. There is no generic method dispatch, browser credential reuse, direct session-file mutation, second Host, or force writer takeover. The socket request limit is 64 KiB so the supported 8192-character prompt bound also works for multi-byte CJK text; an authenticated socket test covers an 8K CJK prompt.

The application-side complete mode adds:

- exact provider routing for Telegram replies, with Codex/dsh collision detection and unchanged latest-Codex behavior for text without `reply_to_message`;
- durable dsh reply intent and duplicate/payload-mismatch protection;
- `/dsh_new`, project menus, ForceReply first-prompt collection, and direct `/dsh_new <project> <prompt>`;
- `/dsh_model` opaque model selection and namespaced `dsh.default_model` preference;
- stable session/request IDs, create/adopt + prompt dedup contracts, and no automatic replay after ambiguous create/model/prompt dispatch;
- accepted-creation recovery that can finish Telegram acknowledgement without rediscovering projects/models or replaying Host writes;
- created-session first-turn observer markers and conflict detection;
- opaque, hashed, chat-bound, expiring, single-use Telegram callback tokens with periodic cleanup;
- completion/failure/interruption notifications that include the durable session title when available and the complete redacted committed assistant answer when present; long answers are split into ordered Telegram-safe chunks, every chunk maps to the exact session, and only the final chunk carries the optional 24-hour Reply button in write mode;
- fail-soft `SEA_BRIDGE_DSH_READ_ONLY_ENABLED`, `SEA_BRIDGE_DSH_WRITE_ENABLED`, and `SEA_BRIDGE_DSH_NOTIFICATIONS_ENABLED` gates;
- restart recovery that moves unresolved dispatching reply/creation writes to `delivery_unknown`;
- observer-contract migration from the known metadata-only fingerprint to the terminal-text fingerprint without resetting the cursor or replaying old history; unknown contracts still fail closed;
- per-session outbox ordering across polls/retries so an earlier chunk failure blocks later chunks for that session without blocking other sessions.

The install/check command is now `scripts/install-dsh-connector.sh` and snapshots `index.mjs`, `host-operations.mjs`, `package.json`, and `cordis.patch.yml`. It verifies file hashes/private modes and does not restart the Host implicitly.

Final automated verification for the complete branch implementation: `bun test` passed **165/165** with **628 expectations**; `./node_modules/.bin/tsc --noEmit`, `bun run build`, and `git diff --check` passed. The connector's own Node suite passed, including authenticated write operations, the 8K CJK socket prompt, title projection, exact-turn committed assistant-text projection, and reasoning/tool-data exclusion. Populated-state migration, provider isolation, crash-window recovery, lifecycle gating/backoff, observer shutdown, ordered multipart delivery, and Codex regressions are included in those tests.

**Code-completion boundary at that checkpoint:** repository tests alone did not prove the installed target-Mac connector was `0.4.0` or that live Telegram received final-answer text. The subsequent target-Mac deployment and its separate acceptance evidence follow below.

## Target-Mac deployment and live Telegram acceptance (2026-10-01)

- The user-designated `ai-chat` test session was used; unrelated existing sessions were not selected for prompt tests. Private backups of the preceding connector, LaunchAgent plists, and an online SQLite snapshot were taken before the upgrade. `scripts/install-dsh-connector.sh install` then `check` verified the installed 0.4.0 snapshot. Only the existing dsh Web Host was restarted; live health reported `connectorVersion: 0.4.0`, with 73 sessions, 2 projects, 4 model groups, successful follow/page reads, a durable title, and a nonempty exact-turn `turn.summary` for the test session.
- Sea-Bridge switched to the isolated `e8b49e6` release with read, write, and notification gates enabled. Startup reported connector 0.4.0; all 73 observer rows migrated from the known metadata-v1 fingerprint to terminal-text-v2 without resetting their cursors or replaying historical notifications. The running release's `src/main.ts` hash matched the later squash-merged `main` content.
- A short accepted test prompt produced a sent, mapped completion notification (Telegram message 1237). A second accepted prompt produced 5,439 characters of committed visible assistant text; the formatter made two ordered messages of 3,434 and 2,068 characters (1238 and 1239), both sent and mapped to the same test session. The user confirmed both parts were visible on the phone. A native Telegram Reply to **the first, nonfinal part** (1238) was recorded as `delivered` to that exact session with no error, followed by another sent and mapped completion notification (1247).
- Before integration, `bun test` passed 165/165 with 628 expectations, connector Node tests passed 12/12, `./node_modules/.bin/tsc --noEmit`, `bun run build`, and `git diff --check` passed. After PR #4 squash-merged as `caf52c2`, the same 165/165 suite, 12/12 connector tests, typecheck, and build passed on `main`. The source branch was subsequently deleted. These checks and the live Telegram observations are different evidence scopes.

**Still unproven in live acceptance:** the phone UI placement of the final-chunk-only shortcut Reply button, project/model menu and callback flows in the same run, deliberate connector token-rotation/fault/restart and rollback drills, and the full create/reply crash-window no-replay matrix. Those paths have automated coverage where specified, but this record does not promote it to target-Mac E2E proof. Do not mark the broader implementation-plan E2E tasks complete solely from the short/multipart notification and native Reply results.

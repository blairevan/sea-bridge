# Sea-Bridge Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use the repository's plan-execution/TDD workflow task-by-task. Keep the checkboxes current. Do not skip failing-test-first gates for security, persistence, idempotency, or source-routing behavior.

**Goal:** Add a Chinese Sea-Bridge Web console for local and Tailnet-only administration, with authenticated pairing, session inspection, Codex/dsh session creation and follow-up, operation diagnostics, device revocation, and Web-only global redaction, while preserving existing Telegram/Codex/dsh behavior.

**Architecture:** The existing Sea-Bridge process remains the only application process. A new loopback-only Bun HTTP server exposes a static Web UI and same-origin API. A separate private Unix control socket creates one-time pairing codes. Web state uses additive SQLite tables and separate source adapters for Codex and dsh. The Web layer never reuses Telegram update/message IDs or Telegram model preferences. Side-effecting requests are durably claimed before dispatch and ambiguous post-dispatch failures are never automatically replayed. Tailscale Serve is an external Tailnet HTTPS reverse proxy only; Sea-Bridge never binds to a Tailnet/LAN address or enables Funnel.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Bun HTTP server, Node/Bun built-ins, vanilla HTML/CSS/JavaScript, existing Codex CLI/App Server and dsh connector. No new runtime dependency without explicit approval.

**Spec:** `docs/superpowers/specs/2026-10-02-web-console-design.md`

**Planning status (2026-10-02):** design approved by the user. This document is the implementation recipe; business code has not yet been changed for this feature.

---

## Global Constraints

- Create implementation work on a dedicated feature branch (user explicitly declined worktree on 2026-10-02); do not implement on the documentation branch.
- Preserve all existing Telegram routing semantics and dsh gates.
- `executionSource` is only `codex | dsh`; `transport` is `web | telegram`. Never model Telegram as an execution source.
- Never reuse `telegram_update_id`, `telegram_chat_id`, Telegram callback tables, or Telegram default-model state for Web idempotency or Web user state.
- Web HTTP must bind only to loopback. Do not add a configurable arbitrary bind host and do not bind `0.0.0.0` or a Tailnet IP.
- Do not enable Tailscale Funnel. Do not let Sea-Bridge mutate global Tailscale configuration during normal application startup.
- Do not infer a Codex project for an existing thread unless a verified source supplies the relation.
- Do not invent dsh user-message history or project ownership when the connector does not expose it.
- Do not automatically retry any side effect after the operation has crossed its dispatch boundary and the result is ambiguous.
- Do not treat `codex queue` exit code 0 as proof that a turn has started.
- Do not send a Web-created Codex first message with the existing `[Telegram init]` prefix.
- Do not send follow-up `codex queue` messages to a newly created Codex thread while Sea-Bridge's first-turn App Server session still owns that thread.
- Do not implement Web approval in V1. App Server approvals for Web-created Codex work continue through the existing Telegram approval channel.
- Never persist active 8-digit pairing codes in SQLite.
- Never persist raw session tokens or raw CSRF tokens.
- Never persist known secret values in new Web logs or Web message snapshots.
- Do not use localStorage, IndexedDB, Service Worker caches, or URL query parameters for message bodies/session tokens/CSRF tokens.
- Source text is plain text in V1. No Markdown/HTML rendering.
- All list/history/search APIs are bounded and paginated.
- Maintain TDD: focused failing test → minimal implementation → focused pass → regression suite.
- Every migration is additive, idempotent, transactional, and tested against a database containing existing Sea-Bridge data.
- Web startup is fail-soft. A Web-specific port/config/migration/static-asset failure must not stop the existing Telegram/dsh bridge after core `StateDb` is already healthy.

---

## File Map

| File | Responsibility |
|---|---|
| `src/config.ts` | Add Web enable/port/control-socket/remote-origin/runtime-secret configuration with safe defaults. |
| `src/main.ts` | Compose Web stores, source adapters, control socket, HTTP server, and fail-soft lifecycle. |
| `src/security/redact.ts` | Preserve existing redaction behavior; add reusable permanent-secret and optional privacy-display filtering. |
| `src/desktop/codex-app-server-client.ts` | Make first-turn input transport-neutral and expose owner-release evidence needed by Web. |
| `src/desktop/new-thread-manager.ts` | Preserve Telegram's existing `[Telegram init]` behavior at the Telegram-specific layer. |
| `src/telegram/service.ts` | Expose a narrow read-only polling health snapshot for Web status; no routing behavior change. |
| `src/web/types.ts` | Web API/source/domain types and stable error/status contracts. |
| `src/web/migrations.ts` | Web-only schema version and additive transactional migrations. |
| `src/web/store.ts` | Settings, device sessions, CSRF hashes, operation claims, message snapshots, logs, audit, cleanup. |
| `src/web/crypto.ts` | Random tokens/codes, constant-time checks, hashes/HMACs, opaque IDs. |
| `src/web/auth.ts` | Session-cookie auth, pairing verification, CSRF verification, trusted request-context classification. |
| `src/web/control-server.ts` | Private Unix socket for local pair-code creation only. |
| `scripts/web-control.ts` | Local CLI client, initially `pair` only. |
| `src/web/redaction.ts` | Web display/storage filtering policy layered on shared secret redaction. |
| `src/web/codex-transcript.ts` | Bounded, fixture-backed Codex rollout user/assistant text reader. |
| `src/web/sources/types.ts` | Unified source capabilities and session/history/create/send contracts. |
| `src/web/sources/codex.ts` | Codex list/history/catalog/create/send/status adapter. |
| `src/web/sources/dsh.ts` | dsh list/history/catalog/create/send/status adapter using only proven Host operations. |
| `src/web/status.ts` | Cached evidence-based Codex/dsh/Telegram capability summary. |
| `src/web/events.ts` | SSE connection registry for settings-version and session-revocation control events. |
| `src/web/http.ts` | Request parsing, size limits, routing, JSON errors, headers, auth/CSRF, API handlers. |
| `src/web/server.ts` | Loopback Bun server lifecycle and static-file delivery. |
| `src/web/public/index.html` | Console shell and accessible structure. |
| `src/web/public/app.css` | Responsive desktop/mobile layout. |
| `src/web/public/app.js` | No-framework UI state, polling, SSE, forms, pagination, redaction-version handling. |
| `scripts/build.ts` | Build main code and copy Web static assets into a self-contained `dist`. |
| `package.json` | Route `build` through the build script; add local `web:pair` command. |
| `tests/web-*.test.ts` | Focused Web persistence/auth/security/source/API/build/lifecycle tests. |
| `tests/fixtures/codex-rollout-web/*.jsonl` | Sanitized verified Codex message-shape fixtures only. |
| `docs/ai/2026-10-02-web-console-acceptance.md` | Target-host deployment/Tailscale/real-device evidence and remaining gates. |

If implementation shows that one proposed file would become trivial or duplicate an existing narrow module, merging adjacent responsibilities is acceptable. Do not collapse auth, state, source adapters, and HTTP routing into one large file.

---

## Stable API and State Vocabulary

### Execution sources

```ts
export type WebExecutionSource = "codex" | "dsh";
export type WebTransport = "web" | "telegram";
```

### Source capabilities

At minimum expose independent booleans/status for:

```ts
export interface WebSourceCapabilities {
  sessionsReadable: boolean;
  projectsReadable: boolean;
  modelsReadable: boolean;
  historyReadable: boolean;
  completeUserHistoryReadable: boolean;
  finalReplyReadable: boolean;
  createEnabled: boolean;
  sendEnabled: boolean;
  approvalTransport: "telegram" | null;
}
```

A single `available=true` is insufficient.

### Web operation states

Use a small stable state machine; API display strings remain separate from stored machine values.

```text
received
  -> dispatching
      -> queued            # Codex queue process returned success; execution still unproven
      -> accepted          # Host/source explicitly accepted
      -> failed            # definite pre/post-dispatch failure with reliable negative result
      -> delivery_unknown  # dispatch may have happened; never auto-replay
```

Creation may additionally store a known `session_id` as soon as it exists, even while the first prompt result remains unknown.

### API response metadata

Every dynamic authenticated JSON response includes current settings version, preferably both:

- header: `X-Sea-Bridge-Settings-Version: <integer>`;
- response envelope field: `settingsVersion`.

Every HTML/dynamic API response uses `Cache-Control: no-store`.

---

# Task 0: Freeze Baseline, Create Implementation Worktree, and Record Target Preconditions

**Files:**
- Update only when implementation begins: `docs/ai/2026-10-02-web-console-acceptance.md`

**Purpose:** Start from a reproducible clean baseline and prevent the Web feature from masking existing failures.

- [x] **Step 1: Verify the documentation branch is clean except for the approved spec/plan.**

Record:
- current commit;
- approved spec path;
- plan path;
- current full test/typecheck/build results.

Expected: any pre-existing failure is recorded before implementation and is not attributed to Web work.

- [x] **Step 2: Create an isolated implementation branch/worktree.**

Selected branch: `feature/web-console` in the existing checkout; user explicitly declined worktree on 2026-10-02.

The documentation commit(s) containing the approved spec/plan must be in the implementation branch base.

- [x] **Step 3: Capture target-host runtime facts read-only.**

Record without secrets:
- Bun version;
- Sea-Bridge launch mechanism and restart command;
- current Sea-Bridge process command;
- whether `tailscale` CLI exists on the actual Mac host;
- current `tailscale version`;
- current `tailscale serve status --json`;
- whether any Funnel/Serve routes already exist;
- current listeners relevant to the proposed Web port.

Do not change Serve/Funnel in this task.

- [x] **Step 4: Create the acceptance evidence document.**

Write only sanitized facts and mark all not-yet-tested runtime gates pending.

- [x] **Step 5: Run baseline checks.**

```bash
bun test
bun run typecheck
bun run build
git diff --check
```

Expected: baseline status is known before code changes.

---

# Task 1: Remove Telegram-Specific Coupling from the Codex First-Turn Primitive

**Files:**
- Modify: `src/desktop/codex-app-server-client.ts`
- Modify: `src/desktop/new-thread-manager.ts`
- Modify: `tests/codex-app-server-client.test.ts`
- Modify: `tests/new-thread-manager.test.ts`
- Modify: `tests/telegram-project-new-thread.test.ts`

**Goal:** Make `CodexAppServerClient.startThreadAndTurn()` send exactly the supplied text while preserving Telegram's current external behavior at the Telegram-specific manager layer.

- [x] **Step 1: Add a failing client test proving exact first-turn text.**

Given prompt `hello`, the JSON-RPC `turn/start.input[0].text` must be exactly `hello`.

Expected before fix: test observes `[Telegram init]\nhello` and fails.

- [x] **Step 2: Add a failing Telegram-manager regression test.**

Calling `NewThreadManager.startThread(..., "hello")` must still pass `[Telegram init]\nhello` to the transport-neutral App Server primitive.

This protects existing Telegram-generated thread semantics.

- [x] **Step 3: Remove the prefix from `CodexAppServerClient`.**

The low-level method becomes transport-neutral. Put the prefix in `NewThreadManager` only.

Do not change handshake, permissions, turn lifetime, unsubscribe, or approval handler behavior.

- [x] **Step 4: Expose safe first-turn ownership/release state.**

Web needs to know whether a newly created thread is still held by Sea-Bridge's App Server session. Implement a narrow callback/result hook or owner registry contract, for example:

```ts
onThreadStarted?: (threadId: string) => void;
onOwnershipReleased?: (threadId: string, turnId: string) => void;
```

The callback fires only when the session has reached its release boundary (completed/unsubscribe/final process cleanup). Avoid making the whole App Server session public.

- [x] **Step 5: Add race/regression tests.**

Cover:
- thread ID callback occurs before first-turn result;
- ownership-release callback occurs once;
- failure before thread creation does not report an owner;
- failure after thread creation allows the Web layer to retain the thread ID;
- Telegram behavior remains unchanged.

- [x] **Step 6: Run focused and full checks.**

```bash
bun test tests/codex-app-server-client.test.ts tests/new-thread-manager.test.ts tests/telegram-project-new-thread.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `refactor: make codex first turn transport neutral`.

---

# Task 2: Add Web Configuration and Fail-Soft Lifecycle Skeleton

**Files:**
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Create: `src/web/types.ts`
- Create: `src/web/server.ts` initially as lifecycle skeleton
- Create: `tests/web-lifecycle.test.ts`
- Modify: any config fixture objects in existing tests

**Configuration:**

Add at minimum:

```ts
webEnabled: boolean;                  // SEA_BRIDGE_WEB_ENABLED, default false
webPort: number;                      // SEA_BRIDGE_WEB_PORT, choose a non-conflicting default
webControlSocketPath: string;         // SEA_BRIDGE_WEB_CONTROL_SOCKET
webRemoteOrigin: string | null;       // SEA_BRIDGE_WEB_REMOTE_ORIGIN, exact https origin
webOperationPepperPath: string;       // private high-entropy persisted HMAC key
```

Do not add `SEA_BRIDGE_WEB_HOST`; bind host is a code constant `127.0.0.1`.

- [x] **Step 1: Write config tests first.**

Cover:
- Web disabled by default;
- valid port;
- invalid/out-of-range port rejected;
- remote origin absent is valid;
- remote origin must be exact `https://host[:port]` with no path/query/userinfo;
- control socket and pepper paths expand under home correctly;
- legacy configs/tests still construct `AppConfig`.

- [x] **Step 2: Add lifecycle tests.**

Inject a fake Web service and prove:
- disabled Web creates nothing;
- Web start failure is logged and Telegram/dsh composition continues;
- shutdown stops Web HTTP and control socket before closing StateDb;
- double shutdown remains safe.

- [x] **Step 3: Implement configuration.**

Create private parent directories with mode `0700` where appropriate. Do not print secret-file contents.

- [x] **Step 4: Add the disabled/no-op lifecycle skeleton.**

Do not expose routes yet. The server constructor should require explicit dependencies; avoid importing global singleton state.

- [x] **Step 5: Re-run full regression.**

```bash
bun test tests/web-lifecycle.test.ts
bun test
bun run typecheck
bun run build
git diff --check
```

Commit boundary recommendation: `feat: add web console lifecycle gate`.

---

# Task 3: Add Web-Only Schema Migrations and Typed State Store

**Files:**
- Create: `src/web/migrations.ts`
- Create: `src/web/store.ts`
- Create: `src/web/crypto.ts`
- Create: `tests/web-store.test.ts`

**Tables:**

Use Web-prefixed tables, with exact final names chosen once and kept stable. Suggested logical schema:

- `web_schema_migrations`
- `web_settings` — singleton redaction flag + monotonically increasing version
- `web_device_sessions` — device ID, session hash, paired/last-active/expires/revoked timestamps, display name
- `web_csrf_tokens` — device/session binding + token hash + expiry
- `web_operations` — operation ID, kind, source, canonical HMAC, target/project/model, state, known session/turn/result IDs, error code, timestamps
- `web_message_snapshots` — Web-origin user text after permanent secret filtering only
- `web_logs`
- `web_audit`

Do not add an active pair-code table.

- [ ] **Step 1: Write an on-disk upgrade test.**

Seed a database with representative current Telegram/Codex/dsh rows, close it, run Web migrations, reopen, and assert every existing row is unchanged.

- [ ] **Step 2: Test migration idempotency and transaction rollback.**

Run migrations twice. Inject a migration failure in a test transaction and prove no half-created version is recorded.

- [ ] **Step 3: Test default settings.**

First initialization creates:
- redaction enabled;
- version `1` (or another documented initial positive version).

Concurrent compare-and-set update must allow only the expected version.

- [ ] **Step 4: Test device/session and CSRF storage.**

Assert:
- only hashes are stored;
- expiry and revocation are enforced;
- last activity update is bounded to avoid a DB write for every polling request (e.g. update at most once per minute);
- cleanup removes expired sessions/tokens.

- [ ] **Step 5: Test operation atomic claim.**

`claimOperation(id, canonicalDigest, ...)` returns:
- `new` for the first claim;
- `duplicate` for same ID + same digest;
- `mismatch` for same ID + different digest.

Use a keyed HMAC for the canonical raw operation payload with an install-local random pepper so low-entropy prompts are not represented by a plain offline-guessable digest in SQLite. The pepper lives in a private `0600` file and never appears in logs/API/database. Tests must recreate the store/auth stack with the same pepper file and prove a previously claimed operation still compares as the same request after process restart; missing/corrupt pepper after operations exist is a Web startup error, not a silent key regeneration that would destroy idempotency.

- [ ] **Step 6: Test legal state transitions and crash recovery.**

At startup:
- `dispatching` becomes `delivery_unknown`;
- terminal states remain terminal;
- `received` may remain safely redispatchable only if the code path proves no source call can happen before the transition to `dispatching`.

Prefer the invariant: transactionally transition to `dispatching` immediately before source invocation; any recovered `dispatching` is unknown and never auto-replayed.

- [ ] **Step 7: Test early session-ID persistence.**

A creation operation can store `session_id` independently from final operation state.

- [ ] **Step 8: Test retention.**

Enforce both age and count:
- Web logs: 7 days / max 10,000;
- operations, snapshots, audit: 30 days / max 10,000 each.

- [ ] **Step 9: Implement store and crypto helpers.**

Use constant-time comparisons where comparing secret-derived values is relevant. Do not invent custom encryption.

- [ ] **Step 10: Run focused and full checks.**

```bash
bun test tests/web-store.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `feat: add isolated web console state`.

---

# Task 4: Implement Local Pair-Code Control Socket and Browser Authentication

**Files:**
- Create: `src/web/control-server.ts`
- Create: `src/web/auth.ts`
- Create: `scripts/web-control.ts`
- Modify: `package.json`
- Create: `tests/web-auth.test.ts`
- Create: `tests/web-control-server.test.ts`

**Local control protocol:**

Keep the allowlist fixed. V1 needs one command:

```json
{"op":"pair.create"}
```

Response contains the one-time code and expiry only. No generic RPC dispatch.

- [ ] **Step 1: Write pair-code generation tests.**

Prove:
- exactly 8 numeric digits;
- generated from a cryptographically secure RNG;
- 5-minute expiry;
- creating a new code invalidates the old code;
- single successful use invalidates it;
- process restart/new auth-manager instance cannot reuse an old code;
- SQLite contains no active code or code hash.

Store only an in-memory MAC of the code using a process-random key plus expiry/failure counters.

- [ ] **Step 2: Write brute-force/rate-limit tests.**

Cover:
- max 5 failures/minute per trusted source bucket;
- max 10 failures per active code;
- global failure ceiling;
- generic error response for nonexistent/expired/wrong code;
- successful pairing resets only appropriate transient counters.

Use injected clock/RNG for deterministic tests.

- [ ] **Step 3: Write control-socket permission/lifecycle tests.**

Prove:
- parent dir is private;
- stale socket cleanup is safe;
- live foreign socket is not unlinked blindly;
- socket permissions are private;
- malformed/oversized/multiple requests are rejected;
- stop removes the owned socket.

- [ ] **Step 4: Implement `web:pair` CLI.**

Suggested package command:

```json
"web:pair": "bun run scripts/web-control.ts pair"
```

The CLI prints the code and expiration to the local terminal only. It never logs the control response through the application logger.

- [ ] **Step 5: Implement device session issuance.**

On successful browser pairing:
- generate >=256 bits random session token;
- store only its hash;
- generate a separate high-entropy CSRF token;
- store only its hash bound to the device session;
- create a validated optional device display name;
- set 30-day absolute expiry, no sliding extension.

Cookie policy:
- session cookie: host-only, `HttpOnly; SameSite=Strict; Path=/`;
- CSRF cookie: host-only, readable by JS, `SameSite=Strict; Path=/`;
- add `Secure` for the configured remote HTTPS host;
- local HTTP cookie remains separate because it is host-only.

- [ ] **Step 6: Implement trusted request context classification.**

Allow only exact hosts/origins:
- `http://127.0.0.1:<port>`;
- optionally `http://localhost:<port>`;
- configured `SEA_BRIDGE_WEB_REMOTE_ORIGIN`.

For a remote-origin request, trust `Tailscale-User-*` only if:
- Host matches the configured remote host exactly;
- the Bun server reports the backend peer as loopback;
- deployment verification confirms that remote host is the Tailscale Serve route.

Identity headers are audit/rate-limit hints only; they never replace Sea-Bridge pairing.

Ignore arbitrary `X-Forwarded-*` for authorization.

- [ ] **Step 7: Implement CSRF verification.**

For authenticated writes require:
- valid session cookie;
- exact allowed Host;
- exact allowed Origin;
- CSRF cookie;
- same token in `X-Sea-Bridge-CSRF`;
- hash matches the stored token for that device session.

SSE uses only the HttpOnly session cookie and never puts a token in the URL.

- [ ] **Step 8: Add logout/revocation primitives.**

Store supports current-device logout and arbitrary device revocation. HTTP/SSE wiring comes later.

- [ ] **Step 9: Run focused and full checks.**

```bash
bun test tests/web-auth.test.ts tests/web-control-server.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `feat: add web console pairing and auth`.

---

# Task 5: Implement Permanent Secret Filtering and Versioned Web Display Redaction

**Files:**
- Modify: `src/security/redact.ts`
- Create: `src/web/redaction.ts`
- Create: `tests/web-redaction.test.ts`
- Modify: `tests/security.test.ts`

**Two layers:**

1. **Permanent storage/response secret filter** — always active.
2. **Optional privacy display filter** — controlled by the Web global setting.

- [ ] **Step 1: Preserve current security tests.**

Any existing `redact()` contract used by Telegram/logging must stay compatible unless a stricter behavior is demonstrably safe.

- [ ] **Step 2: Add tests for explicit known secret values.**

Build the Web secret filter from currently loaded secret config values such as Telegram token and other explicitly secret values available to Sea-Bridge. Replace exact occurrences in nested objects, strings, URLs, multi-line text, and error messages.

Do not expose the list of known secrets in diagnostics.

- [ ] **Step 3: Add permanent pattern tests.**

Cover:
- Bearer auth;
- Authorization/Cookie-like values;
- token/secret/password/api-key key names;
- PEM private-key blocks;
- common URL query secret forms;
- multiline values.

- [ ] **Step 4: Add optional privacy-display tests.**

When Web redaction is enabled additionally mask:
- email;
- phone-like values;
- IPv4/IPv6;
- local absolute paths.

When disabled, these ordinary privacy fields may remain, but permanent secrets remain filtered.

- [ ] **Step 5: Add operation/message-storage tests.**

The source receives the original raw prompt. The Web message snapshot receives only permanently secret-filtered text. This distinction is mandatory.

- [ ] **Step 6: Implement version-aware response wrapper.**

Every dynamic response is filtered according to a single settings-version snapshot. Do not fetch the setting separately for every nested field.

- [ ] **Step 7: Run focused/full tests.**

```bash
bun test tests/security.test.ts tests/web-redaction.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `feat: add web display redaction policy`.

---

# Task 6: Build a Safe Codex Transcript Reader and Codex Web Source Adapter

**Files:**
- Create: `src/web/codex-transcript.ts`
- Create: `src/web/sources/types.ts`
- Create: `src/web/sources/codex.ts`
- Create: `tests/web-codex-transcript.test.ts`
- Create: `tests/web-codex-source.test.ts`
- Create: `tests/fixtures/codex-rollout-web/README.md`
- Create sanitized fixture files under `tests/fixtures/codex-rollout-web/`

**Goal:** Expose only verified Codex thread/session data, bounded user/assistant history, new-thread creation, and existing-thread follow-up.

### 6A. Transcript reader

- [ ] **Step 1: Collect sanitized fixture shapes from existing verified rollout data/code.**

Fixtures contain no real prompt, path, token, user identifier, or project name. Record the Codex schema/version evidence available in the repo/target environment.

- [ ] **Step 2: Write parser tests before implementation.**

Accept only verified message records:
- user text message;
- assistant visible output text;
- stable turn/item identity when present.

Ignore:
- reasoning;
- tool call arguments/results;
- unknown records;
- malformed JSON lines.

Do not synthesize missing user messages.

- [ ] **Step 3: Test path confinement.**

Given `CodexThreadStore.rolloutPath`:
- resolve real path;
- require a regular file;
- require it to live under the configured Codex home/session roots allowed by the implementation;
- reject symlink/path escape;
- reject device/FIFO/socket;
- bound file size/read bytes/page size.

A bad rollout path yields `history_unavailable`, not arbitrary file content.

- [ ] **Step 4: Implement byte/cursor-bounded pagination.**

Prefer a byte-offset/cursor contract that can read recent pages without parsing an unbounded entire rollout on every 3-second refresh. Keep line-boundary handling deterministic.

### 6B. Codex source adapter

- [ ] **Step 5: Add capability/status tests.**

Codex adapter reports independently:
- thread metadata readable;
- history capability;
- projects/models discovery state;
- CLI queue usability evidence;
- new App Server discovery state;
- approval transport = Telegram.

No fresh evidence may be represented as permanent “connected”.

- [ ] **Step 6: Add session-list tests.**

Use `CodexThreadStore.listActive()`, sort newest first for Web, paginate/filter in the adapter/API, and leave project unknown unless verified.

- [ ] **Step 7: Add catalog cache tests.**

Use `CodexAppServerClient.listProjects/listModels` with a Web-specific TTL cache. Concurrent requests coalesce; 3-second session polling does not start App Server discovery repeatedly.

- [ ] **Step 8: Add Web new-thread tests.**

Input includes explicit:
- project ID;
- optional model;
- prompt;
- Web operation ID.

Validate project path exists immediately before creation.

Call transport-neutral `startThreadAndTurn` with raw Web prompt (no Telegram prefix). Persist thread ID via the operation callback as soon as known.

Track first-turn ownership. While held:
- `sendEnabledForSession=false`;
- attempting Web follow-up returns stable `first_turn_owned` without calling queue.

- [ ] **Step 9: Add approval-evidence tests.**

For a known created `threadId/turnId`, query existing `pending_approvals` state through a narrow reader. If pending, project `waiting_external_approval` with `approvalTransport=telegram`.

Do not expose callback tokens or Telegram internals.

- [ ] **Step 10: Add follow-up queue tests.**

Existing/released thread:
- operation enters dispatching before `codex queue`;
- exit 0 maps to `queued`;
- nonzero maps to definite failed;
- no exit/process-aborted maps to `delivery_unknown`;
- no automatic repeat after unknown.

- [ ] **Step 11: Run focused/full checks.**

```bash
bun test tests/web-codex-transcript.test.ts tests/web-codex-source.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `feat: add codex web source adapter`.

---

# Task 7: Build the dsh Web Source Adapter Without Expanding the Host Contract

**Files:**
- Create: `src/web/sources/dsh.ts`
- Create: `tests/web-dsh-source.test.ts`
- Reuse: `src/dsh/web-host-client.ts`, `src/dsh/capabilities.ts`, `src/dsh/history-recovery.ts`

**Goal:** Reuse only already-proven dsh Host calls. No connector change is required merely to make the Web UI look complete.

- [ ] **Step 1: Add capability tests.**

When dsh read-only is disabled:
- sessions/projects/models/history are unavailable.

When reads enabled and writes disabled:
- reads work;
- create/send are explicitly unavailable.

When writes enabled:
- create/send become available subject to Host result.

- [ ] **Step 2: Add session-list tests.**

Expose verified:
- session ID;
- title if present;
- updated time;
- running/blank.

Do not claim project for an old session if Host does not supply it.

- [ ] **Step 3: Add history tests.**

Use metadata/history + exact-turn summary only. Existing dsh user prompts are unavailable and shown as such.

For a Web-origin prompt, merge the matching `web_message_snapshots` user text into the display timeline using the Web operation ID/session ID, without claiming completeness.

- [ ] **Step 4: Add project/model cache tests.**

Cache Host project/model catalog for a short TTL and coalesce concurrent refreshes.

A stale selected model from a prior request is never stored as a Web/global default.

- [ ] **Step 5: Add send tests.**

Derive a dsh request ID in a Web-specific namespace from the Web operation ID.

Map:
- accepted;
- busy/writer-held;
- rejected;
- delivery_unknown.

Busy/writer-held is not queued and not retried automatically.

- [ ] **Step 6: Add create tests.**

Use a deterministic Web-specific session ID derived from the Web operation ID, then:
1. validate project;
2. `session.create`;
3. persist known session ID immediately;
4. optional explicit `session.selectModel`;
5. `prompt.submit` with Web-specific request ID.

Any transport loss after a dispatch boundary maps to `delivery_unknown`; do not “test by retrying”.

- [ ] **Step 7: Prove Telegram state isolation.**

Creating/sending from Web does not read/write:
- Telegram dsh default model;
- Telegram creation request table;
- Telegram update ID;
- Telegram message mapping.

- [ ] **Step 8: Run focused/full checks.**

```bash
bun test tests/web-dsh-source.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `feat: add dsh web source adapter`.

---

# Task 8: Add Evidence-Based Status Service, SSE Registry, and Authenticated HTTP API

**Files:**
- Create: `src/web/status.ts`
- Create: `src/web/events.ts`
- Create: `src/web/http.ts`
- Expand: `src/web/server.ts`
- Create: `tests/web-http.test.ts`
- Create: `tests/web-sse.test.ts`
- Modify: `src/telegram/service.ts`
- Modify: `tests/telegram-service.test.ts` only for the new read-only status projection

## 8A. Request hardening

- [ ] **Step 1: Write bounded-body tests.**

Use a streaming/bounded body reader. Reject before full materialization when possible:
- pairing body over small limit;
- normal JSON body over configured fixed limit;
- invalid/missing JSON;
- unsupported content type.

Do not trust `Content-Length` alone.

- [ ] **Step 2: Write security-header tests.**

HTML:
- `Cache-Control: no-store`;
- strict CSP with self-only scripts/styles and no object/base/frame;
- `X-Content-Type-Options: nosniff`;
- frame denial via CSP and/or `X-Frame-Options: DENY`;
- sensible `Referrer-Policy`.

Dynamic API:
- `Cache-Control: no-store`;
- JSON content type;
- no permissive CORS.

Source text is never inserted as HTML by server templates.

## 8B. Auth routes

Implement:

```text
POST /api/auth/pair
POST /api/auth/logout
GET  /api/auth/session
```

Before auth, no other API reveals status/capabilities/config/session data.

- [ ] **Step 3: Test pair/auth/logout flows end-to-end through the handler.**

`/api/auth/session` returns device identity + settings version but never raw cookie/token hashes.

## 8C. Settings/devices/events

Implement:

```text
GET /api/settings
PUT /api/settings/redaction
GET /api/devices
DELETE /api/devices/:deviceId
GET /api/events
```

- [ ] **Step 4: Test version CAS and SSE.**

Redaction update requires expected version. On success:
- DB version increments;
- audit row records device/time/new boolean;
- all authenticated SSE connections receive only control event `settings_version`;
- no message body travels over SSE.

- [ ] **Step 5: Test revocation.**

Revoking a device:
- marks DB row revoked;
- sends `session_revoked` to that device's SSE if possible;
- closes its SSE;
- subsequent API request is 401.

Revocation does not pretend to cancel an already-dispatched source write.

## 8D. Source/catalog/session/history routes

Suggested routes:

```text
GET /api/status
GET /api/sources/:source/projects
GET /api/sources/:source/models
GET /api/sessions?source=&q=&cursor=&limit=
GET /api/sessions/:source/:sessionId/history?cursor=&limit=
GET /api/operations?source=&sessionId=&status=&from=&to=&cursor=&limit=
```

- [ ] **Step 6: Add pagination/input tests.**

Clamp limits to documented maxima. Reject malformed cursor/date/source/session values.

Search only bounded fields; do not build SQL from raw sort/filter fragments.

- [ ] **Step 7: Implement status caching.**

Status is evidence-based:
- Codex thread-store readability;
- last known CLI/queue check;
- last successful/failed App Server catalog discovery;
- dsh current health/capabilities/observer status;
- Telegram service lifecycle/last polling success/failure evidence.

Add a narrow `TelegramService.getStatus()` projection backed by the service's existing `stopped`, `lastPollSuccessAt`, and `pollFailed` state (plus only the minimum additional timestamp/error code needed). Add a focused regression test for this projection. Do not expose Telegram updates, chat IDs, payloads, or bot tokens through this status object.

Do not spawn `codex --version` every 3 seconds and do not run dsh health for each browser poll. Use TTL/evidence cache.

- [ ] **Step 7A: Persist only useful Web diagnostics.**

Record bounded, permanently secret-filtered Web lifecycle/API/source failure events in `web_logs` and security/control actions in `web_audit`. Do not log successful 3-second polling requests one-by-one, raw prompts, cookies, CSRF values, pair codes, source response bodies, or Tailscale identity strings in full. Logging failure must not turn a successful source operation into a user-visible failure.

## 8E. Side-effect routes

Implement:

```text
POST /api/sessions
POST /api/sessions/:source/:sessionId/messages
```

Body requires browser-created UUID `operationId`.

- [ ] **Step 8: Test idempotency at HTTP boundary.**

Same operation ID + same canonical request:
- returns same persisted operation result;
- does not call source twice.

Same ID + changed source/target/model/prompt:
- stable 409/validation error;
- no source call.

- [ ] **Step 9: Test dispatch ordering.**

Persist/transition to `dispatching` before calling adapter. Test with injected source that inspects DB inside the fake source call.

- [ ] **Step 10: Test raw-vs-snapshot prompt handling.**

Source adapter receives raw prompt. Snapshot/log receives permanent-secret-filtered version.

- [ ] **Step 11: Test settings-version propagation.**

Every successful/error authenticated dynamic response includes current settings version. Client can detect a response older than its latest SSE version.

- [ ] **Step 12: Run focused/full checks.**

```bash
bun test tests/web-http.test.ts tests/web-sse.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `feat: add authenticated web console api`.

---

# Task 9: Implement the No-Dependency Web UI

**Files:**
- Create: `src/web/public/index.html`
- Create: `src/web/public/app.css`
- Create: `src/web/public/app.js`
- Create: `tests/web-static.test.ts`

**V1 screens:**

- pairing;
- overview;
- sessions;
- operation records;
- settings/devices.

### Layout behavior

Desktop:
- side navigation;
- session list;
- session detail.

Mobile:
- list/detail screen navigation;
- fixed composer;
- new session full-screen sheet/page.

- [ ] **Step 1: Add static contract tests.**

Without adding a DOM library, inspect static files for required invariants:
- no external scripts/styles/fonts;
- no inline executable script if CSP forbids it;
- no service worker registration;
- no localStorage/IndexedDB usage;
- form controls have labels;
- source message container is not designed around `innerHTML`.

Keep this test narrow; do not pretend string checks replace browser acceptance.

- [ ] **Step 2: Implement pairing screen.**

Only asks for:
- 8-digit code;
- optional device name.

No pre-auth health/status text.

On success reload authenticated shell.

- [ ] **Step 3: Implement auth/session bootstrap.**

Fetch `/api/auth/session`, obtain current settings version and CSRF cookie value, keep runtime UI state in memory only.

On 401:
- clear rendered state;
- show pairing.

- [ ] **Step 4: Implement polling discipline.**

When visible:
- session list + selected detail every 3 seconds;
- prevent overlapping same-query fetches.

When hidden:
- pause.

On `visibilitychange`/resume/`pageshow`:
1. re-fetch auth/settings;
2. reconcile settings version;
3. then refresh content.

Projects/models/status-expensive probes are not polled every 3 seconds.

- [ ] **Step 5: Implement SSE control handling.**

On newer `settings_version`:
- update known version;
- immediately clear rendered sensitive session/operation fields;
- refetch settings/content.

On SSE disconnect:
- hide/clear sensitive detail area until auth/settings are revalidated;
- reconnect with bounded backoff.

On `session_revoked`:
- clear UI and show pairing.

- [ ] **Step 6: Implement overview/status.**

Use three-state/evidence wording:
- available/limited/unknown/offline as supplied;
- do not turn missing evidence into green “connected”.

Show Codex/dsh capability differences explicitly.

- [ ] **Step 7: Implement sessions page.**

Features:
- source filter;
- title search;
- pagination/load-more;
- history pagination;
- unknown project/user-history states;
- final replies;
- Web-origin snapshot merge.

Use `textContent` and DOM node creation only for source-derived content.

- [ ] **Step 8: Implement creation/follow-up forms.**

New session:
- choose source;
- load source projects/models on demand;
- source-specific capability disabling;
- explicit model selection optional;
- generate `crypto.randomUUID()` operation ID once per submission;
- reuse it for transport retry of that same submission.

Follow-up:
- block when source says busy/writer-held or Codex first-turn owner still held;
- show `queued` distinctly from execution started/completed.

Unknown result:
- show “结果待确认” and a refresh/reconcile action;
- do not add an automatic retry button that silently reuses/new-generates a write.

- [ ] **Step 9: Implement operation records.**

Filter by:
- execution source;
- session;
- status;
- time.

Do not call it a complete message history.

- [ ] **Step 10: Implement settings/devices.**

Redaction:
- CAS with expected version;
- explain permanent secrets are always hidden;
- explain previously viewed/copied data cannot be withdrawn.

Devices:
- name;
- paired time;
- recent activity;
- current-device marker;
- revoke action.

- [ ] **Step 11: Add keyboard/mobile/accessibility basics.**

At minimum:
- visible focus;
- semantic buttons/labels;
- Enter/submit behavior that does not double-submit;
- disabled state during same operation dispatch;
- reasonable viewport behavior;
- no horizontal overflow in message bodies;
- `white-space: pre-wrap` for plain text.

- [ ] **Step 12: Run static/API regression.**

```bash
bun test tests/web-static.test.ts tests/web-http.test.ts
bun test
bun run typecheck
git diff --check
```

Commit boundary recommendation: `feat: add web console ui`.

---

# Task 10: Make Build Output Self-Contained

**Files:**
- Create: `scripts/build.ts`
- Modify: `package.json`
- Create: `tests/web-build.test.ts`
- Possibly modify: `src/web/server.ts` static-root resolution only

**Goal:** Development and built deployments both serve the Web assets without relying on the repository's `src/web/public` directory at runtime.

- [ ] **Step 1: Write build-output test first.**

Build to a temporary output directory and assert:
- compiled server entry exists;
- copied `web/index.html`, `web/app.js`, `web/app.css` exist;
- no source tree is needed to locate them.

- [ ] **Step 2: Replace package build command with a deterministic build script.**

Use Bun/fs built-ins only:
1. clean/create output dir safely;
2. run `Bun.build`;
3. copy static assets;
4. fail if required asset missing.

Do not delete arbitrary directories based on unchecked environment input.

- [ ] **Step 3: Test source-mode and dist-mode static resolution.**

Inject/resolve static root so tests can prove both:
- `bun run src/main.ts` style;
- built `dist` layout.

- [ ] **Step 4: Add a dist Web-server smoke test.**

Start the Web server component from built code with temporary config/dependencies, not the Telegram long-polling main loop. Request:
- `/`;
- JS;
- CSS;
- an authenticated API test route/handler setup where practical.

Expected: no hidden `src/` dependency and no 404.

- [ ] **Step 5: Run full checks.**

```bash
bun test tests/web-build.test.ts
bun test
bun run typecheck
bun run build
git diff --check
```

Commit boundary recommendation: `build: package web console assets`.

---

# Task 11: Wire Full Lifecycle and Preserve Existing Bridge Behavior

**Files:**
- Modify: `src/main.ts`
- Modify: `src/config.ts` if final wiring reveals only implementation-level fields
- Create/expand: `tests/web-lifecycle.test.ts`
- Modify relevant existing Telegram/dsh lifecycle tests only as required for dependency injection

- [ ] **Step 1: Compose Web dependencies only after core state is healthy.**

Suggested order:
1. load config / logger / `StateDb`;
2. existing bridge dependencies;
3. if Web enabled, run Web migrations and construct Web stores/auth;
4. construct source adapters from the already-existing Codex/dsh clients/stores;
5. start local control socket;
6. start loopback HTTP server.

If Web-specific setup fails, log a permanently secret-filtered error and continue existing bridge startup.

- [ ] **Step 2: Recover ambiguous Web operations before accepting writes.**

Run operation recovery before HTTP starts.

- [ ] **Step 3: Start/stop ordering tests.**

Shutdown:
1. stop accepting Web HTTP;
2. close SSE;
3. stop control socket;
4. continue existing Telegram/dsh/observer/hook/app-server shutdown;
5. close StateDb last.

- [ ] **Step 4: Add Web-disabled regression.**

With default env, main composition behavior must remain materially identical to pre-feature Sea-Bridge.

- [ ] **Step 5: Add Web-enabled/dsh-disabled regression.**

Codex Web still works while dsh reports unavailable.

- [ ] **Step 6: Add Web-enabled/dsh-read-only regression.**

dsh sessions/catalog/history work; dsh create/send controls are disabled.

- [ ] **Step 7: Run all automated checks.**

```bash
bun test
bun run typecheck
bun run build
git diff --check
```

No target-host deployment until this task is green.

Commit boundary recommendation: `feat: wire web console runtime`.

---

# Task 12: Target-Mac Local Acceptance Before Tailscale Exposure

**Files:**
- Update: `docs/ai/2026-10-02-web-console-acceptance.md`
- No code changes unless acceptance exposes a reproducible bug; fix via TDD then rerun automated suite.

**Gate:** Test on localhost first. Do not configure Tailscale Serve until local auth/security/source behavior passes.

- [ ] **Step 1: Inspect deployment files before editing.**

Record:
- env file path/mode;
- launch agent/service label;
- restart command;
- existing Web-related env keys if any;
- chosen free loopback port.

Do not print token values.

- [ ] **Step 2: Enable Web locally only.**

Set:
- `SEA_BRIDGE_WEB_ENABLED=true`;
- port/control socket/pepper path as needed;
- leave remote origin unset.

Restart Sea-Bridge using its existing service mechanism.

- [ ] **Step 3: Prove listener scope.**

Use read-only socket inspection. Expected:
- listener exists only on `127.0.0.1:<port>` (and only IPv6 loopback if intentionally implemented; do not expose wildcard);
- no `0.0.0.0`;
- no LAN/Tailnet bind.

- [ ] **Step 4: Pair locally.**

Run `bun run web:pair`.

Verify:
- code prints locally;
- wrong attempts are generic/rate-limited;
- correct attempt pairs once;
- page refresh retains session;
- code cannot be reused;
- restart invalidates an unconsumed old code but does not invalidate valid device sessions.

- [ ] **Step 5: Verify Codex real flows.**

On a safe project/test context:
- list projects/models;
- create Web Codex session;
- verify first prompt has no `[Telegram init]`;
- verify Telegram approval is used if a prompt triggers approval;
- verify follow-up is blocked while first-turn owner is held;
- after release, send follow-up;
- confirm actual turn evidence/final reply rather than trusting queue exit only;
- verify existing Telegram new-thread flow still sends the historical prefix and works.

- [ ] **Step 6: Verify dsh real flows according to enabled gates.**

If writes enabled:
- create one test session;
- optional explicit model;
- first prompt;
- exact follow-up;
- busy/writer-held behavior if safely reproducible.

If writes disabled, prove the UI is read-only and does not expose enabled send/create controls.

- [ ] **Step 7: Verify history limitations visibly.**

Check:
- old dsh session does not invent user prompts/project;
- Codex malformed/unavailable rollout shows a bounded unavailable state;
- Web-origin messages appear as Web snapshots where designed.

- [ ] **Step 8: Verify redaction across two local browser contexts if possible.**

Toggle global setting and verify:
- settings version increments;
- other active client clears/refetches;
- permanent token/private-key patterns remain hidden when redaction is off;
- no raw source content in localStorage/IndexedDB/cache storage.

- [ ] **Step 9: Verify device revoke.**

Revoke second device:
- SSE closes;
- next API is unauthorized;
- already-dispatched write is not falsely reported canceled.

- [ ] **Step 10: Record sanitized evidence.**

Do not paste real message bodies/tokens/cookies into docs.

---

# Task 13: Tailscale Serve Preflight and Tailnet-Only Acceptance

**Files:**
- Update: `docs/ai/2026-10-02-web-console-acceptance.md`
- Update deployment env with exact remote origin after Serve hostname is confirmed.
- Do not add Funnel.

**Gate:** Local acceptance from Task 12 must pass first.

- [ ] **Step 1: Read current Tailscale state on the real host.**

Run:
- `tailscale version`;
- `tailscale status --json`;
- `tailscale serve status --json`.

Record:
- tailnet hostname;
- existing Serve routes;
- existing Funnel state;
- ACL/grants/share facts relevant to who can reach this machine.

If another service already owns the desired Serve path/port, do not overwrite it. Choose a non-conflicting route or stop and report the conflict.

- [ ] **Step 2: Establish a reversible Serve change.**

Before modification, capture the existing Serve config in sanitized form sufficient for rollback.

Configure one Tailnet HTTPS Serve route to the Sea-Bridge loopback URL. Do not enable Funnel.

The application itself remains on loopback.

- [ ] **Step 3: Set exact remote origin.**

Set `SEA_BRIDGE_WEB_REMOTE_ORIGIN=https://<actual-serve-host>`.

Restart Sea-Bridge only if env/config change requires it.

- [ ] **Step 4: Verify remote request classification.**

From a Tailnet browser:
- pair separately;
- Secure host-only session cookie works;
- exact remote Origin/Host accepted;
- forged `X-Forwarded-*` does not grant anything;
- Tailscale identity headers, where present, affect only audit/rate-limit metadata;
- a tagged/no-user-header path still requires pairing.

- [ ] **Step 5: Prove no public exposure.**

Verify:
- `tailscale serve status` shows Serve, not Funnel;
- no wildcard/LAN listener;
- public/non-tailnet path cannot reach the console;
- unauthenticated Tailnet browser sees only pairing.

- [ ] **Step 6: Test phone + second Tailnet computer.**

Cover:
- pairing;
- refresh;
- sessions/history;
- create/send in a safe test context;
- device revoke;
- redaction synchronization.

- [ ] **Step 7: Test failure modes.**

At least:
- dsh Host unavailable;
- Codex CLI unavailable or safe simulated adapter failure;
- Web SSE disconnect/reconnect;
- Sea-Bridge restart with valid device session;
- operation left `dispatching` in a test DB/startup recovery path.

Avoid destructive fault injection into production conversations.

- [ ] **Step 8: Record rollback procedure.**

Document exactly how to:
- disable `SEA_BRIDGE_WEB_ENABLED`;
- remove only the Sea-Bridge Serve route while restoring prior Serve config;
- restart Sea-Bridge;
- verify Telegram/dsh continue.

---

# Task 14: Final Review, Regression, Documentation, and Delivery

**Files:**
- Update: `docs/superpowers/specs/2026-10-02-web-console-design.md`
- Update: `docs/superpowers/plans/2026-10-02-web-console.md`
- Update: `docs/ai/2026-10-02-web-console-acceptance.md`
- Update any operator README only if a stable user-facing command/env setting must be documented.

- [ ] **Step 1: Run a security-focused review.**

Manually trace:
- pair code generation/verification;
- cookie flags;
- CSRF;
- Host/Origin;
- Tailscale header trust boundary;
- raw prompt path vs stored snapshot;
- operation idempotency;
- log filtering;
- rollout path confinement;
- HTML/text rendering;
- device revocation;
- SSE auth;
- no tokens in URLs.

- [ ] **Step 2: Run source-isolation review.**

Prove:
- Web Codex create does not mutate Telegram model preference;
- Web dsh create does not use Telegram tables;
- Telegram direct-text/latest-link semantics unchanged;
- Telegram approval path still works;
- dsh Telegram notifications/replies unchanged.

- [ ] **Step 3: Run final automated suite.**

```bash
bun test
bun run typecheck
bun run build
git diff --check
```

Also run focused Web tests explicitly so failures are easy to locate.

- [ ] **Step 4: Review final diff for scope.**

No:
- unrelated refactor;
- new unapproved runtime dependency;
- secret fixture;
- production token/cookie;
- Tailscale Funnel config;
- wildcard listener;
- browser credential scraping;
- generic dsh RPC expansion.

- [ ] **Step 5: Update implementation status in spec/plan.**

Document:
- exact completed capabilities;
- exact runtime gates that passed;
- any intentionally unavailable history fields;
- any remaining manual acceptance gate.

Do not mark a runtime feature complete because source code exists.

- [ ] **Step 6: Commit and push only after all required checks pass.**

Use small logical commits during implementation if helpful; final branch should have a clean working tree.

---

## Required Automated Test Matrix

Before calling implementation complete, the following areas must have explicit automated coverage:

| Area | Required proof |
|---|---|
| Config | default-off, fixed loopback behavior, valid remote origin, invalid port/origin rejection |
| Migration | upgrade with existing Codex/Telegram/dsh rows, idempotency, rollback |
| Pair code | crypto RNG, 8 digits, 5 min, single-use, new-invalidates-old, restart invalidates, never in DB |
| Pair brute force | per-source, per-code, global limits, generic failures |
| Device auth | hashed tokens, expiry, revoke, host-only cookies, Secure remote cookie |
| CSRF | cookie + header + stored hash + exact Origin/Host |
| Proxy trust | spoofed headers ignored outside trusted Serve context |
| SSE | authenticated only, no URL token, settings event, revoke/close, reconnect behavior |
| Secret filter | config secrets, Bearer/Cookie, URL secrets, private keys, nested/multiline |
| Privacy filter | email/phone/IP/path only when enabled |
| Codex prefix | raw Web prompt; Telegram keeps `[Telegram init]` |
| Codex owner | no queue follow-up until first-turn owner release |
| Codex transcript | verified user/assistant only; tool/reasoning ignored; path escape rejected |
| Codex queue | success=queued only, definite fail, unknown, no replay |
| dsh history | no invented old user prompt/project; Web snapshot merge only |
| dsh writes | accepted/busy/rejected/unknown, deterministic Web IDs, no Telegram state |
| Idempotency | atomic claim, same payload duplicate, mismatch rejection, crash recovery |
| API bounds | body/list/history/search/cursor limits |
| XSS | source content plain text, CSP/security headers |
| Redaction sync | CAS conflict, version propagation, stale response handling contract |
| Retention | age + count cleanup |
| Build | copied static assets and dist-only Web smoke |
| Lifecycle | Web fail-soft and shutdown order |
| Regression | existing Telegram/Codex/dsh test suites pass |

---

## Final Acceptance Criteria

Implementation is complete only when all of the following are true:

1. Existing Sea-Bridge Telegram/Codex/dsh automated tests pass.
2. Web is default-off and enabling it does not change existing routing semantics.
3. Web backend is proven to listen only on loopback.
4. Pair codes are local-only, one-time, short-lived, rate-limited, and not persisted in SQLite.
5. Device sessions/CSRF tokens are stored only as hashes and cookies have the required flags.
6. Unauthenticated HTTP reveals only the pairing page/flow.
7. Side-effecting Web operations are durably claimed before dispatch and ambiguous writes are never auto-replayed.
8. Web-created Codex first turns contain no Telegram prefix.
9. A newly created Codex thread cannot be queued to until its App Server owner is released.
10. Telegram remains the approval channel for Web-created Codex work in V1.
11. dsh Web operations do not reuse Telegram IDs/preferences/state.
12. Old dsh sessions do not display fabricated user prompts/projects.
13. Codex transcript reads are fixture-backed, bounded, and path-confined.
14. Permanent secrets remain redacted even when Web privacy redaction is disabled.
15. Redaction-version changes clear/refetch other clients through SSE control events.
16. Source content is rendered as plain text under strict security headers.
17. Built artifacts serve Web assets without depending on `src/`.
18. Tailscale remote access uses Serve only, with no Funnel and no wildcard application listener.
19. Phone and second Tailnet-computer acceptance pass.
20. The acceptance document records exact evidence and any remaining limitation without overstating capability.

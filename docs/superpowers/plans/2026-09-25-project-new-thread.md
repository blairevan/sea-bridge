# Project New Thread & Model Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authorized Telegram user inspect Codex projects/models and create a new project-scoped thread whose first turn actually starts, while preserving the existing Sea-Bridge reply routing semantics.

**Architecture:** Treat `codex app-server` as the protocol authority for project discovery, model discovery, thread creation, and first-turn startup. Do not read/write Codex project tables directly. Add persistent state for model preference and the interactive `/new` ForceReply flow. The 2026-09-25 target-host PoC confirmed that, after `thread/start + turn/start` establishes the thread and rollout, follow-up messages can reuse the existing `ProcessCodexQueueClient` / `codex queue` path.

**Tech Stack:** TypeScript, Bun, SQLite (`bun:sqlite`), Node child_process, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-09-25-project-new-thread-design.md`

**Implementation Status (2026-09-25):** Code implementation is complete on `feature/project-new-thread`. After a second full code Review, automated verification passes: `bun test` 52/52, `bun run typecheck`, `bun run build`, and `git diff --check`. The second Review fixed the new-thread Observer baseline race, removed the fixed 30-minute active-turn kill, made app-server discovery failures non-blocking for Telegram updates/callbacks, revalidated pending project paths before creation, and preserved correct expired/consumed ForceReply semantics. Target-host Telegram/Desktop final acceptance remains pending. The detailed checkboxes below are retained as the implementation recipe and historical checklist.

## Global Constraints

- Never commit secrets, API keys, tokens, account data, or raw private prompts.
- Maintain TDD: failing test first, minimal implementation, regression test last.
- Do not infer Codex behavior from private SQLite tables when an app-server API exists.
- app-server handshake order is mandatory: `initialize` → successful response → `initialized` → other RPCs.
- Initial prompt must use `turn/start` on the same app-server context as `thread/start`.
- Do not use a hard-coded fallback model list.
- Phase 0 protocol PoC has passed on the target Mac; keep Desktop sidebar/open/restart behavior in final acceptance to detect version-specific regressions.
- Do not silently swallow malformed JSON-RPC or process failures.
- Existing semantics remain unchanged: direct Telegram text routes to the latest Sea-Bridge message link in that chat; no “active-thread” check is added.

---

## Task 0: Target-host protocol/Desktop PoC — **Completed / Gate Passed**

**Purpose:** Validate the exact ChatGPT/Codex Desktop build and bundled Codex binary on the machine that actually runs Sea-Bridge.

**Status (2026-09-25):** Core protocol gate passed on the current Mac. The checklist below is retained as a reproducible verification procedure; Desktop sidebar/open/restart behavior remains part of Task 7 acceptance.

**Files:**
- Create only if useful: `scripts/poc-project-new-thread.ts`
- Update after run: `docs/superpowers/specs/2026-09-25-project-new-thread-design.md`

- [ ] **Step 1: Record target versions** _(protocol Gate 已通过；仍需补录具体 Desktop 与 bundled Codex 版本，便于后续复现/回归)_

Run on the macOS host, outside the DevSpace container:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex --version
/Applications/ChatGPT.app/Contents/Resources/codex app-server --help
```

Also record the Desktop app version from the app.

- [x] **Step 2: Verify mandatory handshake**

PoC sequence:

```text
initialize(id=1, experimentalApi=true)
wait initialize response
initialized notification
model/list
project/list
```

Expected:
- no “Not initialized” error;
- model/list returns live model data;
- project/list returns the target project with correct `id`, `roots`, and `position`.

- [x] **Step 3: Verify thread + first turn**

With Desktop already open:

```text
thread/start(projectId=<id>, cwd=<roots[0].path>, model=<optional>)
turn/start(threadId=<new id>, input=[{type:"text", text:"PoC: reply with a short confirmation", textElements:[]}])
```

Wait for a terminal turn event.

Expected:
- thread/start returns thread.id;
- turn/start returns turn.id;
- the first turn reaches completed or a clearly classified failure.

- [ ] **Step 4: Verify live Desktop integration (final acceptance / regression check)**

Without restarting Desktop:
- confirm the new thread appears in the intended project/sidebar;
- open it;
- confirm history renders;
- send one Desktop message and verify the thread continues normally.

- [x] **Step 5: Verify Sea-Bridge observation**

Confirm the current `DesktopObserver` can discover the new rollout and produce the expected Telegram notification lifecycle.

- [x] **Step 6: Verify follow-up dispatch after creation**

After first turn completes:
- test `codex queue --thread <id> --message <text>`;
- verify a new turn actually starts, not merely that the CLI exits zero;
- inspect queue/thread state if needed.

- [x] **Step 7: Gate decision**

**Protocol Gate PASS criteria:**
1. `project/list` and `thread/start.projectId` work on the bundled version;
2. `turn/start` starts the first turn with the validated text payload shape;
3. rollout/observer state is produced;
4. `codex queue` is proven to start a real follow-up turn.

These protocol criteria passed on 2026-09-25. Desktop sidebar discovery/open behavior remains a Task 7 final acceptance and regression check; a UI regression should be reported separately rather than silently changing the proven transport.

**Commit only if a PoC script/doc update was created:**

```bash
git add scripts/poc-project-new-thread.ts docs/superpowers/specs/2026-09-25-project-new-thread-design.md
git commit -m "docs: record project new-thread compatibility PoC"
```

---

## Task 1: CodexAppServerClient — Protocol-correct JSON-RPC client — **Completed**

**Files:**
- Create: `src/desktop/codex-app-server-client.ts`
- Test: `tests/codex-app-server-client.test.ts`

**Interfaces:**

```ts
export interface ProjectItem {
  index: number;
  id: string;
  name: string;
  roots: string[];
  primaryRoot: string;
  position: number;
}

export interface ModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface StartedThread {
  threadId: string;
  turnId: string;
  projectId: string;
  cwd: string;
  model: string | null;
}

export class CodexAppServerClient {
  constructor(codexCliPath: string, options?: CodexAppServerClientOptions);

  listProjects(): Promise<ProjectItem[]>;
  listModels(): Promise<ModelOption[]>;
  startThreadAndTurn(params: {
    projectId: string;
    cwd: string;
    model?: string;
    prompt: string;
  }): Promise<StartedThread>;
}
```

- [ ] **Step 1: Write handshake test first**

Test must assert exact ordering:
1. client writes `initialize`;
2. mock returns initialize result;
3. client writes `initialized`;
4. only then client writes target RPC.

The test must fail if `model/list`, `project/list`, `thread/start`, or `turn/start` is sent before `initialized`.

- [ ] **Step 2: Test JSONL framing and interleaved notifications**

Cover:
- multiple JSON objects in one stdout chunk;
- one JSON object split across chunks;
- unrelated notifications between request and response;
- `\n` and `\r\n`;
- malformed JSON produces a classified/loggable failure rather than silent ignore.

- [ ] **Step 3: Implement request-id correlation**

Do not hard-code all target RPCs to id=2.

Maintain monotonically increasing request ids per process/connection and resolve responses by matching id.

- [ ] **Step 4: Implement `listProjects()`**

Use `project/list` with `experimentalApi: true`.

Requirements:
- paginate until `nextCursor === null`;
- bounded maximum number of pages/items to protect against protocol bugs;
- preserve `position` ordering;
- ignore projects with zero roots for `/new`;
- `primaryRoot = roots[0]`;
- assign 1-based Telegram indices after filtering.

Tests:
- single page;
- multi-page;
- zero-root project filtered;
- duplicate project names preserved as separate items.

- [ ] **Step 5: Implement `listModels()`**

Use live `model/list`.

Requirements:
- return live `id`, `displayName`, `isDefault`;
- exclude hidden models if the response includes them;
- no hard-coded fallback list;
- RPC failure propagates as a typed/classified error so Telegram can show a useful message.

- [ ] **Step 6: Implement `startThreadAndTurn()`**

Within the same app-server session:
1. `thread/start`;
2. validate `result.thread.id`;
3. `turn/start` using the returned thread id;
4. validate returned turn id;
5. return `StartedThread`.

First prompt format remains:

```text
[Telegram init]
<user prompt>
```

Tests:
- projectId/cwd/model passed correctly;
- model omitted when no preference exists;
- turn/start never runs if thread/start fails;
- success is not returned if turn/start fails;
- threadId is retained in the thrown diagnostic context if thread/start succeeded but turn/start failed.

- [ ] **Step 7: Implement bounded shutdown**

For query-only sessions:
- close stdin;
- wait briefly for normal exit;
- SIGTERM if needed;
- SIGKILL only as the final fallback.

For a session with an active turn:
- implement exactly the lifecycle proven by Task 0;
- do not kill the process immediately after turn/start merely because the RPC response arrived.

- [ ] **Step 8: Run focused tests**

```bash
bun test tests/codex-app-server-client.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/desktop/codex-app-server-client.ts tests/codex-app-server-client.test.ts
git commit -m "feat(desktop): add protocol-correct Codex app-server client"
```

---

## Task 2: StateDb settings + pending new-thread prompt state — **Completed**

**Files:**
- Modify: `src/state/db.ts`
- Create: `src/state/new-thread-state-store.ts`
- Test: `tests/new-thread-state-store.test.ts`

- [ ] **Step 1: Write migration tests first**

Add schema:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_new_thread_prompts (
  telegram_chat_id TEXT NOT NULL,
  prompt_message_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','consumed','expired')),
  PRIMARY KEY (telegram_chat_id, prompt_message_id)
);
```

Migration must be safe when `StateDb` opens the same DB more than once.

- [ ] **Step 2: Add settings API**

Suggested interface:

```ts
getSetting(key: string): string | null;
setSetting(key: string, value: string): void;
deleteSetting(key: string): void;
```

Use:
- `default_model`

Tests:
- missing → null;
- insert;
- overwrite;
- delete restores null.

- [ ] **Step 3: Implement NewThreadStateStore**

Suggested API:

```ts
createPendingPrompt(input: {
  chatId: string;
  promptMessageId: number;
  projectId: string;
  projectName: string;
  cwd: string;
  ttlMs: number; // use 15 * 60_000 for this feature
}): void;

consumePendingPrompt(
  chatId: string,
  promptMessageId: number,
  now?: number,
): PendingNewThreadPrompt | null;
```

`consumePendingPrompt` must be atomic:
- return pending row once;
- transition to consumed in the same transaction;
- expired rows must not be returned as usable.

- [ ] **Step 4: Test idempotency + TTL**

Cover:
- first consume succeeds;
- second consume returns null;
- expired prompt returns null and is marked expired;
- different chats/message ids do not collide.

- [ ] **Step 5: Run tests**

```bash
bun test tests/new-thread-state-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state/db.ts src/state/new-thread-state-store.ts tests/new-thread-state-store.test.ts
git commit -m "feat(state): persist new-thread prompts and model setting"
```

---

## Task 3: Telegram `/projects` and `/model` — **Completed**

**Files:**
- Modify: `src/telegram/service.ts`
- Test: `tests/telegram-model-projects.test.ts`

**Important compatibility note:** Existing `TelegramClient.sendMessage()` accepts `InlineButton[][]` as its third argument, not a raw Telegram `reply_markup` object. Tests must use the existing client contract.

- [ ] **Step 1: Write `/projects` failing test**

Inject a mock app-server client whose `listProjects()` returns:
- normal projects;
- duplicate names;
- enough projects to exercise message splitting if implemented in this task.

Assert:
- index, name, and primaryRoot are shown;
- help text recommends `/new <index> <prompt>`;
- no SQL/private state DB dependency exists.

- [ ] **Step 2: Implement `/projects`**

Rules:
- fetch live projects;
- split output into Telegram-safe message chunks;
- if app-server fails, send an explicit unavailable/error message.

- [ ] **Step 3: Write `/model` failing test**

Cases:
- no stored model → “Codex 默认” marked selected;
- stored model → that model marked selected;
- live list failure → no fabricated model list.

- [ ] **Step 4: Implement `/model`**

Buttons:
- first row: Codex default;
- following rows: live models.

Callback format should remain within Telegram's callback-data size limit. Use a compact prefix.

- [ ] **Step 5: Implement model callback**

On specific model:
- store `default_model`.

On default:
- delete `default_model`.

Then:
- answer callback;
- update keyboard with `editMessageReplyMarkup`.

If a callback references a model no longer present in the live catalog:
- do not save it;
- answer with “模型列表已变化，请重新打开 /model”.

- [ ] **Step 6: Run focused tests**

```bash
bun test tests/telegram-model-projects.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/service.ts tests/telegram-model-projects.test.ts
git commit -m "feat(telegram): add project and model menus"
```

---

## Task 4: Direct `/new <index> <prompt>` — **Completed**

**Files:**
- Modify: `src/telegram/service.ts`
- Test: `tests/telegram-new-thread.test.ts`

- [ ] **Step 1: Write direct-create failing test**

Input:

```text
/new 1 帮我写单元测试
```

Assert:
- current project list is fetched;
- index 1 resolves to the expected project;
- setting `default_model` is read;
- `startThreadAndTurn()` receives projectId, primaryRoot, optional model, and prompt;
- **`ProcessCodexQueueClient.queue()` is not called for the initial prompt**.

- [ ] **Step 2: Implement parser**

Supported direct forms:
- `/new <numeric-index> <prompt>`
- optional exact unique project name for simple names.

Rules:
- numeric index is the documented/recommended path;
- ambiguous name → explain ambiguity and ask user to use index;
- missing prompt → enter interactive project flow, do not create an empty thread;
- no fuzzy/partial project matching.

- [ ] **Step 3: Implement success mapping**

After `startThreadAndTurn()` succeeds:
1. send success message;
2. link the sent Telegram message to threadId/turnId in `DesktopMessageStore`.

The success message must say “已创建会话并开始执行”, not merely “已创建”.

- [ ] **Step 4: Implement failure semantics**

Cases:
- invalid project index;
- app-server unavailable;
- thread/start failure;
- turn/start failure;
- stale/unsupported stored model.

No failed create attempt may become the latest DesktopMessageStore mapping.

- [ ] **Step 5: Run focused test**

```bash
bun test tests/telegram-new-thread.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/service.ts tests/telegram-new-thread.test.ts
git commit -m "feat(telegram): create Codex thread and first turn from /new"
```

---

## Task 5: Interactive `/new` → project callback → ForceReply → create — **Completed**

**Files:**
- Modify: `src/telegram/service.ts`
- Modify: `src/state/new-thread-state-store.ts`
- Test: `tests/telegram-new-thread.test.ts`

- [ ] **Step 1: Test empty `/new`**

Assert:
- sends project buttons with at most 8 projects per page;
- shows previous/next pagination buttons when needed;
- callback data contains projectId, not display index;
- pagination callback data uses a distinct prefix from project-selection callbacks.

- [ ] **Step 2: Test project callback**

On project callback:
1. answer callback;
2. re-fetch project data by projectId;
3. send ForceReply prompt;
4. persist `pending_new_thread_prompts` using the ForceReply message id.

- [ ] **Step 3: Route ForceReply before normal thread-reply routing**

When a text message replies to a Telegram message:
1. first check whether the replied-to message is a pending new-thread prompt;
2. if yes, atomically consume it and create the new thread;
3. only when no pending-new-thread record exists should the existing `routeThreadReply()` path run.

This ordering prevents the ForceReply from being misclassified as an unmapped Desktop reply.

- [ ] **Step 4: Test TTL and duplicate consumption**

- expired pending prompt → ask user to send `/new` again;
- duplicate reply/update → never create a second thread;
- service restart between project selection and user reply still works because state is in SQLite.

- [ ] **Step 5: Run focused tests**

```bash
bun test tests/telegram-new-thread.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/service.ts src/state/new-thread-state-store.ts tests/telegram-new-thread.test.ts
git commit -m "feat(telegram): add persistent interactive new-thread flow"
```

---

## Task 6: Follow-up transport for Sea-Bridge-created threads — **Completed**

**PoC-selected transport:** reuse the existing `ProcessCodexQueueClient` after the first `thread/start + turn/start` has successfully established the thread and produced rollout state. No long-lived second app-server dispatcher is planned for this version.

**Files:**
- Modify only if needed: `src/telegram/thread-reply-router.ts`
- Test: `tests/telegram-thread-reply-router.test.ts`

- [x] **Step 1: Record PoC-selected transport in the design**

Selected behavior: reuse current `ProcessCodexQueueClient`. The target-host PoC confirmed that `codex queue` starts follow-up turns after the initial app-server-created turn is established. No app-server ownership table and no second follow-up dispatcher are required.

- [ ] **Step 2: Write a regression test for direct text routing**

Existing behavior must remain:

```text
message has reply_to_message -> explicit mapped thread
message has no reply_to_message -> DesktopMessageStore.findLatestLink(chatId)
```

No “thread active” condition is introduced.

- [ ] **Step 3: Verify real execution, not process exit**

Integration verification must prove that a follow-up creates/starts the next Codex turn. Exit code 0 from `codex queue` alone is insufficient.

- [ ] **Step 4: Commit if applicable**

Commit message depends on the selected transport.

---

## Task 7: Main wiring, shutdown, and full regression — **Implementation Complete / Target-host Acceptance Pending**

**Files:**
- Modify: `src/main.ts`
- Possibly modify: `src/config.ts`
- Test: existing suites + new integration-focused tests

- [ ] **Step 1: Wire new dependencies**

Instantiate:
- `CodexAppServerClient`
- `NewThreadStateStore`

Pass them into `TelegramService` without disturbing existing constructor dependencies.

Prefer an options/dependencies object if constructor positional arguments become difficult to read; do not append an unbounded list of optional positional parameters.

- [ ] **Step 2: Add clean shutdown**

If the final `CodexAppServerClient` implementation keeps any child process alive beyond a single RPC sequence, track it explicitly and close it during Sea-Bridge shutdown before `StateDb.close()`. Do not introduce a long-lived thread-owner process solely for follow-up routing.

- [ ] **Step 3: Run type/lint/build checks available in the repository**

Inspect `package.json` and run all project-defined static checks.

- [ ] **Step 4: Run full tests**

```bash
bun test
```

Expected: PASS.

- [ ] **Step 5: Target-host acceptance**

With Desktop already running:

1. `/projects`;
2. `/model`;
3. `/new 1 测试创建会话`;
4. confirm first turn executes;
5. confirm Desktop immediately shows/opens the thread;
6. send a second Telegram message without reply;
7. confirm it routes to the newly created thread and starts another turn;
8. send an explicit reply to an older Sea-Bridge notification and confirm explicit reply still overrides latest-link routing;
9. restart Sea-Bridge and repeat the interactive `/new` ForceReply flow.

- [ ] **Step 6: Update spec status**

Only after the target-host acceptance passes:
- change spec status from `Approved / Ready to Implement — target-host protocol PoC passed`
- to `Approved / Implemented` (or the project's normal completed status);
- record actual Desktop + bundled Codex versions and final acceptance results.

- [ ] **Step 7: Final commit**

```bash
git add src tests docs/superpowers/specs/2026-09-25-project-new-thread-design.md docs/superpowers/plans/2026-09-25-project-new-thread.md
git commit -m "feat: support project-scoped Codex thread creation from Telegram"
```

---

## Review Notes Preserved for Implementer

1. The existing `DesktopMessageStore.findLatestLink(chatId)` behavior is intentional and must remain: direct Telegram input targets the most recent Sea-Bridge-linked thread in that chat.
2. The current `TelegramClient.sendMessage` abstraction accepts button arrays, not raw Telegram `reply_markup`; tests and implementation should follow the existing wrapper.
3. `StateDb` currently has no generic preferences table; migration must be additive and idempotent.
4. Current `TelegramService.run()` processes fetched updates sequentially, so do not add an in-memory “session mutex” unless a concrete race remains after persistent pending-state/idempotency handling.
5. Do not couple this feature to `state_5.sqlite.projects` / `project_roots`; app-server `project/list` is the protocol surface for this design.

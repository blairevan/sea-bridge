# Telegram ↔ Codex Desktop 消息桥接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不依赖 Vibe Notch、Hook 或审批机制的条件下，把 Codex Desktop 每轮最终回复与状态变化推送至 Telegram，并将 Telegram 对通知的回复准确投递回原 Desktop thread。

**Architecture:** Sea-Bridge 只读轮询 Codex 的 `state_5.sqlite` 与 rollout JSONL，构建 `threadId + turnId + eventFingerprint` 的出站事件。Telegram 通知与 Codex threadId 映射持久化在 Sea-Bridge SQLite；入站消息必须是对通知的回复，随后由参数数组调用 `codex queue --thread <threadId> --message <text>`。

**Tech Stack:** TypeScript 5.8、Bun 1.3、`bun:sqlite`、Node `child_process.spawn`、Telegram Bot API、Codex 本地 SQLite / JSONL。

**Spec:** `docs/superpowers/specs/2026-09-16-telegram-desktop-message-bridge-design.md`

## Global Constraints

- V1 不依赖、不读取、不修改 Vibe Notch。
- V1 不依赖 Codex Hook、远程审批、第二个 App Server 或 GUI 自动化。
- Telegram 必须同时校验 `ALLOWED_USER_ID` 与 `ALLOWED_CHAT_ID`。
- 入站普通消息没有 `reply_to_message` 时不得猜测目标会话。
- `codex queue` 必须用 `spawn(command, args)`，不得拼接 shell 字符串。
- Sea-Bridge 只读访问 Codex 数据库和 rollout JSONL，不修改任何 Codex 文件。
- 输出 Telegram 前继续使用既有 `redact` / `redactedJson` 能力；不传 Token、Cookie、完整 diff 或完整命令输出。
- 当前项目不是 Git 仓库；每个任务完成后记录验证命令与结果，但不执行 commit。
- 当前目标 Desktop 内嵌 Codex 是 `0.154.0-alpha.6.2`；升级后必须重跑 JSONL fixture 与 `codex queue` PoC。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 增加只读 Codex 状态库、CLI 绝对路径、轮询间隔与摘要长度配置。 |
| `src/state/db.ts` | 迁移出站通知映射、入站 delivery 与 JSONL cursor 表。 |
| `src/state/desktop-message-store.ts` | 封装 Telegram 通知映射、delivery CAS、observer cursor。 |
| `src/desktop/codex-thread-store.ts` | 只读查询 Codex `threads` 表，输出稳定的 thread 元数据。 |
| `src/desktop/rollout-parser.ts` | 对目标版本 JSONL 做增量解析，输出状态事件与最终回复。 |
| `src/desktop/desktop-observer.ts` | 协调元数据查询、JSONL cursor、去重与 Telegram 出站。 |
| `src/desktop/codex-queue-client.ts` | 通过安全参数数组调用 `codex queue`。 |
| `src/telegram/service.ts` | Telegram reply 路由替换旧 continuation queue 路径。 |
| `src/main.ts` | 启动和关闭 DesktopObserver；注册新 capability。 |
| `tests/desktop-message-store.test.ts` | 映射与 delivery 幂等测试。 |
| `tests/rollout-parser.test.ts` | 状态与最终回复 fixture 解析测试。 |
| `tests/codex-queue-client.test.ts` | spawn 参数和退出状态测试。 |
| `tests/telegram-thread-reply.test.ts` | Telegram reply-to 映射、鉴权和重复 update 测试。 |
| `tests/fixtures/desktop/codex-message/0.154.0-alpha.6.2/` | 脱敏的真实与最小 JSONL fixture。 |

## Task 1: 配置与持久化消息映射

**Files:**
- Modify: `src/config.ts`
- Modify: `src/state/db.ts`
- Create: `src/state/desktop-message-store.ts`
- Create: `tests/desktop-message-store.test.ts`

**Interfaces:**
- Produces `DesktopMessageStore`：

```ts
export type DeliveryStatus = "received" | "dispatching" | "delivered" | "failed" | "delivery_unknown";
export interface DesktopMessageLink {
  chatId: string;
  messageId: number;
  threadId: string;
  turnId: string | null;
  eventKind: "started" | "waiting_for_input" | "completed" | "failed" | "interrupted";
  eventFingerprint: string;
}
export class DesktopMessageStore {
  link(message: DesktopMessageLink): void;
  findLink(chatId: string, messageId: number): DesktopMessageLink | null;
  beginDelivery(updateId: number, replyToMessageId: number, threadId: string, textHash: string): "new" | "duplicate";
  finishDelivery(updateId: number, status: Exclude<DeliveryStatus, "received" | "dispatching">, exitCode?: number, errorCode?: string): void;
}
```

- Extends `AppConfig`：

```ts
codexStateDbPath: string;
codexCliPath: string;
desktopPollIntervalMs: number;
telegramSummaryMaxChars: number;
```

- [ ] **Step 1: 写失败测试，覆盖通知映射与 Telegram update 的单次消费**

```ts
test("maps one Telegram notification to one Desktop thread", () => {
  const store = new DesktopMessageStore(new StateDb(":memory:"));
  store.link({
    chatId: "42", messageId: 99, threadId: "thread-a", turnId: "turn-1",
    eventKind: "completed", eventFingerprint: "event-1",
  });
  expect(store.findLink("42", 99)?.threadId).toBe("thread-a");
});

test("claims a Telegram reply update only once", () => {
  const store = new DesktopMessageStore(new StateDb(":memory:"));
  expect(store.beginDelivery(101, 99, "thread-a", "hash")).toBe("new");
  expect(store.beginDelivery(101, 99, "thread-a", "hash")).toBe("duplicate");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/desktop-message-store.test.ts`  
Expected: FAIL，提示 `DesktopMessageStore` 尚未定义。

- [ ] **Step 3: 增加配置字段与 SQLite migration**

```sql
CREATE TABLE IF NOT EXISTS desktop_message_links (
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  event_kind TEXT NOT NULL,
  event_fingerprint TEXT NOT NULL UNIQUE,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_chat_id, telegram_message_id)
);
CREATE TABLE IF NOT EXISTS telegram_thread_deliveries (
  telegram_update_id INTEGER PRIMARY KEY,
  reply_to_message_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  queue_exit_code INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS desktop_observer_cursors (
  thread_id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  schema_fingerprint TEXT NOT NULL,
  last_event_fingerprint TEXT,
  updated_at INTEGER NOT NULL
);
```

Use defaults:

```ts
const codexStateDbPath = expandHome(process.env.SEA_BRIDGE_CODEX_STATE_DB_PATH ?? "~/.codex/state_5.sqlite");
const codexCliPath = expandHome(process.env.SEA_BRIDGE_CODEX_CLI_PATH ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
const desktopPollIntervalMs = positiveInt("SEA_BRIDGE_DESKTOP_POLL_INTERVAL_MS", 2_000);
const telegramSummaryMaxChars = positiveInt("SEA_BRIDGE_TELEGRAM_SUMMARY_MAX_CHARS", 3_000);
```

- [ ] **Step 4: 实现 `DesktopMessageStore` 的 SQL CAS**

```ts
const result = this.state.db.query(
  "INSERT OR IGNORE INTO telegram_thread_deliveries(telegram_update_id,reply_to_message_id,thread_id,text_hash,status,created_at) VALUES (?,?,?,?,?,?)",
).run(updateId, replyToMessageId, threadId, textHash, "received", Date.now());
return result.changes === 1 ? "new" : "duplicate";
```

- [ ] **Step 5: 运行模块测试与类型检查**

Run: `bun test tests/desktop-message-store.test.ts && bun run typecheck`  
Expected: PASS。

## Task 2: 只读读取 Desktop thread 与增量解析 rollout

**Files:**
- Create: `src/desktop/codex-thread-store.ts`
- Create: `src/desktop/rollout-parser.ts`
- Create: `tests/rollout-parser.test.ts`
- Create: `tests/fixtures/desktop/codex-message/0.154.0-alpha.6.2/completed.jsonl`
- Create: `tests/fixtures/desktop/codex-message/0.154.0-alpha.6.2/waiting-for-input.jsonl`
- Create: `tests/fixtures/desktop/codex-message/0.154.0-alpha.6.2/failed.jsonl`

**Interfaces:**

```ts
export interface CodexThread {
  id: string;
  rolloutPath: string;
  title: string;
  updatedAtMs: number;
}
export interface DesktopTurnEvent {
  threadId: string;
  turnId: string | null;
  kind: "started" | "waiting_for_input" | "completed" | "failed" | "interrupted";
  finalText: string | null;
  fingerprint: string;
}
export class CodexThreadStore {
  listUpdated(sinceMs: number): CodexThread[];
}
export function parseRolloutChunk(threadId: string, jsonl: string): DesktopTurnEvent[];
```

- [ ] **Step 1: 收集并脱敏当前 `0.154.0-alpha.6.2` 的真实 JSONL fixture**

复制最小事件行到 fixture，替换 Token、Cookie、路径私有部分、命令输出和业务隐私为 `[REDACTED]`。每个 fixture 顶部增加 `_fixture_meta` 行，记录版本、采集日期和来源为 Desktop。

- [ ] **Step 2: 写失败测试，明确解析器不把中间流式文本误判为最终结果**

```ts
test("emits one completed event with final assistant text", () => {
  const events = parseRolloutChunk("thread-a", readFileSync(fixture("completed.jsonl"), "utf8"));
  expect(events).toContainEqual(expect.objectContaining({
    kind: "completed", turnId: "turn-a", finalText: "final answer",
  }));
});

test("does not emit completed for an intermediate assistant item", () => {
  const events = parseRolloutChunk("thread-a", readFileSync(fixture("waiting-for-input.jsonl"), "utf8"));
  expect(events.some((event) => event.kind === "completed")).toBe(false);
});
```

- [ ] **Step 3: 运行解析测试并确认失败**

Run: `bun test tests/rollout-parser.test.ts`  
Expected: FAIL，提示模块不存在。

- [ ] **Step 4: 实现只读 `CodexThreadStore`**

```ts
const codexDb = new Database(this.path, { readonly: true, strict: true });
const rows = codexDb.query(
  "SELECT id, rollout_path, COALESCE(NULLIF(name, ''), title) AS title, recency_at_ms FROM threads WHERE archived=0 AND recency_at_ms>? ORDER BY recency_at_ms ASC",
).all(sinceMs) as Array<{ id: string; rollout_path: string; title: string; recency_at_ms: number }>;
```

- [ ] **Step 5: 实现 parser 的严格白名单**

只接受 fixture 已证明的 JSONL event shape。JSON 解析错误、未知 type、缺失 thread/turn identity 的行返回空事件；不猜测完成状态。用 SHA-256 生成 `threadId + turnId + kind + finalText` 指纹。

- [ ] **Step 6: 运行解析测试与类型检查**

Run: `bun test tests/rollout-parser.test.ts && bun run typecheck`  
Expected: PASS。

## Task 3: 出站 observer 与 Telegram 通知映射

**Files:**
- Create: `src/desktop/desktop-observer.ts`
- Modify: `src/telegram/client.ts`
- Modify: `src/main.ts`
- Create: `tests/desktop-observer.test.ts`

**Interfaces:**

```ts
export interface DesktopObserverDependencies {
  threads: CodexThreadStore;
  messages: DesktopMessageStore;
  telegram: Pick<TelegramClient, "sendMessage">;
  logger: Logger;
  summaryMaxChars: number;
}
export class DesktopObserver {
  start(): void;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
}
```

- [ ] **Step 1: 写失败测试，验证 event 指纹只通知一次且保存 Telegram 映射**

```ts
test("sends one completed notification and stores its thread link", async () => {
  const observer = makeObserverWithEvents([completedEvent("thread-a", "turn-a")]);
  await observer.pollOnce();
  await observer.pollOnce();
  expect(telegram.sent).toHaveLength(1);
  expect(store.findLink("42", telegram.sent[0].message_id)?.threadId).toBe("thread-a");
});
```

- [ ] **Step 2: 运行 observer 测试并确认失败**

Run: `bun test tests/desktop-observer.test.ts`  
Expected: FAIL，提示 `DesktopObserver` 尚未定义。

- [ ] **Step 3: 实现状态格式化与长度限制**

```ts
function notificationText(event: DesktopTurnEvent, title: string, maxChars: number): string {
  const body = event.finalText ? redactedJson(event.finalText, maxChars) : "";
  const suffix = event.finalText && event.finalText.length > maxChars ? "\n内容已截断" : "";
  return [`Codex: ${title}`, `状态: ${event.kind}`, body, suffix].filter(Boolean).join("\n");
}
```

完成、等待输入、失败和中断分别调用 `sendMessage`；成功返回的 `message_id` 立即写入 `desktop_message_links`。

- [ ] **Step 4: 在 main 中启动 observer**

```ts
const observer = new DesktopObserver({ threads, messages, telegram: telegramClient, logger, summaryMaxChars: config.telegramSummaryMaxChars });
observer.start();
// shutdown:
await observer.stop();
```

- [ ] **Step 5: 运行 observer、全量测试与构建**

Run: `bun test tests/desktop-observer.test.ts && bun test && bun run build`  
Expected: PASS。

## Task 4: 精确回注 Telegram reply 到原 thread

**Files:**
- Create: `src/desktop/codex-queue-client.ts`
- Modify: `src/telegram/service.ts`
- Create: `tests/codex-queue-client.test.ts`
- Create: `tests/telegram-thread-reply.test.ts`

**Interfaces:**

```ts
export interface QueueResult {
  status: "delivered" | "failed" | "delivery_unknown";
  exitCode: number | null;
  errorCode?: string;
}
export interface CodexQueueClient {
  queue(threadId: string, text: string): Promise<QueueResult>;
}
```

- [ ] **Step 1: 写 queue client 失败测试，锁定参数数组**

```ts
test("passes thread and message as separate arguments", async () => {
  const spawned: string[][] = [];
  const client = new ProcessCodexQueueClient("/Applications/ChatGPT.app/Contents/Resources/codex", (command, args) => {
    spawned.push([command, ...args]);
    return fakeChild(0);
  });
  await client.queue("thread-a", "[Telegram reply]\nhello");
  expect(spawned[0]).toEqual([
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "queue", "--thread", "thread-a", "--message", "[Telegram reply]\nhello",
  ]);
});
```

- [ ] **Step 2: 运行 queue client 测试并确认失败**

Run: `bun test tests/codex-queue-client.test.ts`  
Expected: FAIL，提示 `ProcessCodexQueueClient` 尚未定义。

- [ ] **Step 3: 实现 `ProcessCodexQueueClient`**

```ts
const child = spawn(this.codexCliPath, ["queue", "--thread", threadId, "--message", text], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
```

对 stdout/stderr 收集最多 4 KiB；非零退出标记 `failed`，信号退出或无法判断退出状态标记 `delivery_unknown`。日志仅保存 exit code 与经过 `redactedJson` 截断的错误摘要。

- [ ] **Step 4: 写 Telegram reply 路由失败测试**

```ts
test("routes an authorized reply to its linked thread", async () => {
  links.link(linkedMessage("42", 99, "thread-a"));
  await service.processForTest(messageUpdate({ updateId: 100, chatId: 42, replyToMessageId: 99, text: "continue" }));
  expect(queue.calls).toEqual([{ threadId: "thread-a", text: "[Telegram reply]\ncontinue" }]);
});

test("does not route a message without reply_to_message", async () => {
  await service.processForTest(messageUpdate({ updateId: 101, chatId: 42, text: "continue" }));
  expect(queue.calls).toHaveLength(0);
  expect(telegram.sent.at(-1)?.text).toContain("回复某条");
});
```

- [ ] **Step 5: 替换旧的普通文本 continuation 逻辑**

在 `TelegramService.handleMessage`：

1. 保留 `/status` 和 user/chat 双鉴权；
2. 如果没有 `message.reply_to_message`，发送固定说明后返回；
3. 使用 `reply_to_message.chat.id + message_id` 查询 `DesktopMessageStore.findLink`；
4. 在调用 queue 前执行 `beginDelivery`；重复 update 直接返回；
5. 调用 `queueClient.queue(link.threadId, "[Telegram reply]\\n" + text)`；
6. 将结果写入 delivery 状态并向 Telegram 回传“已投递”“投递失败”或“不确定，请勿重复发送”。

- [ ] **Step 6: 运行定向测试与全量验证**

Run: `bun test tests/codex-queue-client.test.ts tests/telegram-thread-reply.test.ts && bun test && bun run typecheck && bun run build`  
Expected: PASS。

## Task 5: 真实 Desktop PoC、证据与 capability 收口

**Files:**
- Modify: `docs/telegram-codex-feedback-design.md`
- Modify: `docs/2026-09-11-gemini-next-step-handoff.md`
- Create: `tests/fixtures/desktop/codex-message/0.154.0-alpha.6.2/environment.md`
- Create: `tests/fixtures/desktop/codex-message/0.154.0-alpha.6.2/queue-poc.md`
- Create: `tests/fixtures/desktop/codex-message/0.154.0-alpha.6.2/restart-recovery.md`

**Interfaces:**
- Consumes: Task 1–4 的 observer、mapping、queue client 与 Telegram reply router。
- Produces: `DESKTOP_MESSAGE_BRIDGE=available|pending_poc|unavailable` capability 的实机证据。

- [ ] **Step 1: 启动 Sea-Bridge 并记录环境**

Run:

```bash
cd /opt/app/aitools/sea-bridge
SEA_BRIDGE_ENV_FILE=/opt/app/aitools/sea-bridge/.env /bin/zsh scripts/run-sea-bridge.sh
```

记录 Desktop app 版本、embedded Codex CLI 版本、`state_5.sqlite` schema hash、rollout fixture hash、Sea-Bridge build hash。不得记录 Telegram Token。

- [ ] **Step 2: 完成单 thread 闭环**

1. 在 Codex Desktop 中完成一轮可识别的测试任务；
2. 确认 Telegram 只收到一次 completed 通知；
3. 在 Telegram 回复该通知 `queue-poc-A`；
4. 确认 `codex queue` 退出码为 0；
5. 确认 Desktop 的相同 thread 出现该 Telegram 文本并启动后续 turn；
6. 将 thread ID、Telegram message ID 及文本内容脱敏后写入 `queue-poc.md`。

- [ ] **Step 3: 完成双 thread 防串线 PoC**

1. 并行完成 Desktop thread A 与 B；
2. 对 A 的 Telegram 通知回复 `route-A`，对 B 的通知回复 `route-B`；
3. 确认 A 只收到 `route-A`，B 只收到 `route-B`；
4. 保存脱敏结果。

- [ ] **Step 4: 完成重启与重放 PoC**

1. 在 Telegram 已有一条可回复的 completed 通知时重启 Sea-Bridge；
2. 回复旧通知，确认映射恢复且只投递一次；
3. 重放同一 Telegram update，确认 `telegram_thread_deliveries` 阻止第二次 queue 调用；
4. 保存 `restart-recovery.md`。

- [ ] **Step 5: 更新 capability 与文档结论**

只有 Task 5 的所有 PoC 通过，才将 capability 标为：

```text
DESKTOP_MESSAGE_BRIDGE=available (provider=state_db_rollout_jsonl+codex_queue)
```

若 `codex queue` 未让 Desktop 原 thread 接收消息，标为 `unavailable`，保留实际退出结果和 JSONL 证据；不得用 Headless 或第二 App Server 代替。

- [ ] **Step 6: 最终验证**

Run:

```bash
cd /opt/app/aitools/sea-bridge
bun run typecheck
bun test
bun run build
python3 -m py_compile scripts/codex-hook-bridge.py
```

Expected: 所有静态检查、单元测试、构建通过；实机验收单独记录其通过或失败范围。

## Plan Self-Review

### Spec coverage

- 独立于 Vibe Notch：Task 1–5 只涉及 Sea-Bridge 与 Codex 本地数据。
- 最终回复和状态变化：Task 2、3。
- Telegram reply 精确关联：Task 1、4。
- `codex queue` 实机验证：Task 5。
- 双会话防串线、重启恢复、重复 update：Task 4、5。
- 不依赖 Hook/审批/Headless：全局约束与 Task 5 gate。
- 脱敏与白名单：全局约束、Task 3、4。

### Placeholder scan

已检查本计划，不含未定义步骤或延后交付表述。

### Type consistency

`DesktopMessageLink.threadId`、`DesktopTurnEvent.threadId` 与 `CodexQueueClient.queue(threadId, text)` 在所有任务中统一为 string；Telegram 映射主键统一为 `chatId + messageId`。

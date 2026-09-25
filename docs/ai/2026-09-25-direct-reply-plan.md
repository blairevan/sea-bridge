# 直接回复自动匹配最近一次会话 (Direct Reply Auto-Matching) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 Telegram 用户在聊天中直接输入文本（未点击 Telegram 消息的“回复”按钮）时，系统自动关联该聊天最近一次收到推送通知的 Codex 会话并完成投递。

**Architecture:** 在 `DesktopMessageStore` 中增加 `findLatestLink(chatId)` 方法，以 `sent_at DESC, telegram_message_id DESC` 检索最近一条关联通知；在 `routeThreadReply` 中，当 `reply_to_message` 为空时回退调用 `findLatestLink`，获取目标会话完成投递，若无任何历史通知才提示用户回复指定消息。

**Tech Stack:** Bun, TypeScript, SQLite (`bun:sqlite`), Telegram Bot API

**Spec:** [docs/ai/2026-09-25-direct-reply-design.md](/opt/app/aitools/sea-bridge/docs/ai/2026-09-25-direct-reply-design.md)

## Global Constraints

- 严禁破坏现有通过显式 `reply_to_message` 正常回复的功能逻辑。
- 严禁引入外部未授权第三方依赖。
- 所有新增方法必须有配套的单元测试覆盖。
- 代码保持严格类型注解，通过 `bunx tsc --noEmit` 与 `bun test` 质量门禁。

---

### Task 1: 扩展 `DesktopMessageStore` 查询最近一条消息关联 (`findLatestLink`)

**Files:**
- Modify: `src/state/desktop-message-store.ts`
- Test: `tests/desktop-message-store.test.ts`

**Interfaces:**
- Produces: `findLatestLink(chatId: string): DesktopMessageLink | null` on `DesktopMessageStore`

- [ ] **Step 1: 编写针对 `findLatestLink` 的失败测试**

在 `tests/desktop-message-store.test.ts` 中追加用例：
```ts
  test("finds the latest message link for a given chat", () => {
    const state = new StateDb(":memory:");
    const store = new DesktopMessageStore(state);

    expect(store.findLatestLink("chat-1")).toBeNull();

    store.link({ chatId: "chat-1", messageId: 10, threadId: "thread-1", turnId: "turn-1", eventKind: "started", eventFingerprint: "fp-1" });
    // 后发送的消息
    store.link({ chatId: "chat-1", messageId: 20, threadId: "thread-2", turnId: "turn-2", eventKind: "completed", eventFingerprint: "fp-2" });
    // 另一个 chat 的消息
    store.link({ chatId: "chat-2", messageId: 30, threadId: "thread-3", turnId: "turn-3", eventKind: "completed", eventFingerprint: "fp-3" });

    const latest1 = store.findLatestLink("chat-1");
    expect(latest1?.threadId).toBe("thread-2");
    expect(latest1?.messageId).toBe(20);

    const latest2 = store.findLatestLink("chat-2");
    expect(latest2?.threadId).toBe("thread-3");
    expect(latest2?.messageId).toBe(30);

    state.close();
  });
```

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test tests/desktop-message-store.test.ts`
预期：FAIL（`store.findLatestLink is not a function`）

- [ ] **Step 3: 在 `DesktopMessageStore` 中实现 `findLatestLink`**

在 `src/state/desktop-message-store.ts` 中实现方法：
```ts
  findLatestLink(chatId: string): DesktopMessageLink | null {
    const row = this.state.db.query(
      "SELECT telegram_chat_id,telegram_message_id,thread_id,turn_id,event_kind,event_fingerprint FROM desktop_message_links WHERE telegram_chat_id=? ORDER BY sent_at DESC, telegram_message_id DESC LIMIT 1",
    ).get(chatId) as {
      telegram_chat_id: string;
      telegram_message_id: number;
      thread_id: string;
      turn_id: string | null;
      event_kind: DesktopMessageEventKind;
      event_fingerprint: string;
    } | null;
    if (!row) return null;
    return {
      chatId: row.telegram_chat_id,
      messageId: row.telegram_message_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventKind: row.event_kind,
      eventFingerprint: row.event_fingerprint,
    };
  }
```

- [ ] **Step 4: 运行测试验证通过**

运行：`bun test tests/desktop-message-store.test.ts`
预期：PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/state/desktop-message-store.ts tests/desktop-message-store.test.ts
git commit -m "feat(store): add findLatestLink to DesktopMessageStore"
```

---

### Task 2: 改造 `routeThreadReply` 支持直接回复自动回退

**Files:**
- Modify: `src/telegram/thread-reply-router.ts`
- Test: `tests/telegram-thread-reply-router.test.ts`

**Interfaces:**
- Consumes: `store.findLatestLink(chatId: string)`
- Produces: `routeThreadReply(updateId, message, store, queueClient): Promise<ThreadReplyRouteResult>`

- [ ] **Step 1: 编写针对直接回复场景的失败测试**

在 `tests/telegram-thread-reply-router.test.ts` 中：
将原有 `requires a reply to a mapped Sea-Bridge message` 更新或补充为：
1. 当聊天没有任何通知历史时，直接发送文本返回 `missing_reply`；
2. 当聊天存在通知历史时，直接发送文本自动投递至最新会话；
3. 显式回复不存在的通知时，依然返回 `unmapped_reply`。

```ts
  test("returns missing_reply when no reply_to_message and no prior message links exist", async () => {
    const state = new StateDb(":memory:");
    const store = new DesktopMessageStore(state);
    const queueClient = new ProcessCodexQueueClient("/codex", async () => ({ exitCode: 0, signal: null, stderr: "" }));

    await expect(
      routeThreadReply(10, { message_id: 10, chat: { id: 42, type: "private" }, text: "continue" }, store, queueClient),
    ).resolves.toEqual({ status: "missing_reply" });
    state.close();
  });

  test("delivers direct message without reply_to_message to the latest active thread", async () => {
    const { state, store } = linkedStore();
    // 增加一条更新的 thread-b 记录
    store.link({ chatId: "42", messageId: 105, threadId: "thread-b", turnId: "turn-b", eventKind: "completed", eventFingerprint: "event-b" });

    const calls: string[][] = [];
    const queueClient = new ProcessCodexQueueClient("/codex", async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, signal: null, stderr: "" };
    });

    // 用户直接发送文本，未点击 reply_to_message
    const message = {
      message_id: 200,
      chat: { id: 42, type: "private" },
      text: "hello direct reply",
    };

    const result = await routeThreadReply(50, message, store, queueClient);
    expect(result).toEqual({ status: "delivered", threadId: "thread-b" });
    expect(calls).toEqual([["queue", "--thread", "thread-b", "--message", "[Telegram reply]\nhello direct reply"]]);
    expect(store.getDelivery(50)?.threadId).toBe("thread-b");
    state.close();
  });
```

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test tests/telegram-thread-reply-router.test.ts`
预期：`delivers direct message without reply_to_message to the latest active thread` FAIL（返回 `missing_reply`）

- [ ] **Step 3: 改造 `routeThreadReply` 实现回退逻辑**

在 `src/telegram/thread-reply-router.ts` 中更新：
```ts
export async function routeThreadReply(
  updateId: number,
  message: TelegramMessage,
  store: DesktopMessageStore,
  queueClient: QueueClient,
): Promise<ThreadReplyRouteResult> {
  const reply = message.reply_to_message;
  const link = reply
    ? store.findLink(String(reply.chat.id), reply.message_id)
    : store.findLatestLink(String(message.chat.id));

  if (!link) {
    return reply ? { status: "unmapped_reply" } : { status: "missing_reply" };
  }

  const text = message.text?.trim();
  if (!text) return { status: "failed", threadId: link.threadId };

  const targetMessageId = reply?.message_id ?? link.messageId;
  if (store.beginDelivery(updateId, targetMessageId, link.threadId, textHash(link.threadId, text)) === "duplicate") {
    return { status: "duplicate" };
  }
  if (!store.markDispatching(updateId)) return { status: "duplicate" };

  const result = await queueClient.queue(link.threadId, `[Telegram reply]\n${text}`);
  store.finishDelivery(updateId, result.status, result.exitCode, result.errorCode ?? null);
  return result.status === "delivered"
    ? { status: "delivered", threadId: link.threadId }
    : result.status === "delivery_unknown"
      ? { status: "delivery_unknown", threadId: link.threadId }
      : { status: "failed", threadId: link.threadId };
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`bun test tests/telegram-thread-reply-router.test.ts`
预期：PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/telegram/thread-reply-router.ts tests/telegram-thread-reply-router.test.ts
git commit -m "feat(router): auto-match latest thread when replying directly"
```

---

### Task 3: 全量回归测试与静态质量门禁

**Files:**
- Test: All tests under `tests/`

- [ ] **Step 1: 运行全量测试套件**

运行：`bun test`
预期：所有测试全部通过（0 失败）。

- [ ] **Step 2: 运行类型检查**

运行：`bun run typecheck`
预期：0 类型报错。

- [ ] **Step 3: 检查 git status 与工作区干净度**

运行：`git status`
预期：工作区干净，无未跟踪的多余临时文件。


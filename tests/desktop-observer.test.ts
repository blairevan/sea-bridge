import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexReadService } from "../src/desktop/codex-read-service.ts";
import { CodexCatalogStore } from "../src/desktop/codex-catalog-store.ts";
import { DesktopObserver } from "../src/desktop/desktop-observer.ts";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { CodexObserverStore } from "../src/state/codex-observer-store.ts";
import type { Logger } from "../src/logger.ts";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface TestRpcMessage {
  id?: number;
  method?: string;
  params: Record<string, unknown>;
}

class MockProcess extends EventEmitter {
  stdin = {
    write: (data: string) => {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as TestRpcMessage;
        this.onWrite(message);
      }
      return true;
    },
    end: () => queueMicrotask(() => this.emit("close", 0, null)),
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  constructor(private readonly onWrite: (message: TestRpcMessage) => void) {
    super();
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }

  send(message: unknown): void {
    queueMicrotask(() => this.stdout.emit("data", JSON.stringify(message) + "\n"));
  }
}

interface FixtureOptions {
  now?: number;
  initialStatus?: "inProgress" | "completed" | "failed" | "interrupted";
  createdBySeaBridge?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  let now = options.now ?? 1_000_000;
  let status: "inProgress" | "completed" | "failed" | "interrupted" = options.initialStatus ?? "inProgress";
  let recency = Math.floor(now / 1000);
  let completedAt = status === "completed" ? recency : null;
  let commentaryText: string | null = null;
  let finalText = "final result";
  let runtimeEvidence: { state: "active" | "idle" | "unknown"; turnId: string | null; lastEvent: string } | null = null;
  let proc!: MockProcess;
  proc = new MockProcess((message) => {
    if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
    if (message.method === "thread/list") {
      return proc.send({ id: message.id, result: { data: [{
        id: "thread-a",
        name: "Test thread",
        path: "/tmp/thread-a.jsonl",
        createdAt: recency - 10,
        updatedAt: recency,
        recencyAt: recency,
        source: "cli",
        originator: "codex-tui",
        parentThreadId: null,
        threadSource: "user",
      }], nextCursor: null } });
    }
    if (message.method === "thread/turns/list") {
      return proc.send({ id: message.id, result: { data: [{
        id: "turn-a",
        status,
        startedAt: recency - 1,
        completedAt,
        itemsView: "summary",
      }], nextCursor: null } });
    }
    if (message.method === "thread/items/list") {
      const data: unknown[] = [];
      if (status !== "inProgress" && commentaryText) data.push({
        turnId: "turn-a",
        item: { id: "commentary", type: "agentMessage", text: commentaryText, phase: "commentary" },
      });
      if (status !== "inProgress" && finalText) data.push({
        turnId: "turn-a",
        item: { id: "answer", type: "agentMessage", text: finalText, phase: "final_answer" },
      });
      return proc.send({ id: message.id, result: { data, nextCursor: null } });
    }
  });

  const state = new StateDb(":memory:");
  const messages = new DesktopMessageStore(state);
  const catalog = new CodexCatalogStore(state, "/codex-home");
  const observerStore = new CodexObserverStore(state, "/codex-home");
  observerStore.ensureEnvironment(now);
  if (options.createdBySeaBridge) observerStore.registerCreatedThread("thread-a", now);
  const read = new CodexReadService("/codex", "/codex-home", {
    spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
    requestTimeoutMs: 500,
    restartDelaysMs: [5],
  });
  const sent: Array<{ text: string; buttons: unknown }> = [];
  const observer = new DesktopObserver(
    read,
    catalog,
    observerStore,
    messages,
    {
      sendMessage: async (_chatId: string, text: string, buttons?: unknown) => {
        sent.push({ text, buttons });
        return { message_id: sent.length, chat: { id: 42, type: "private" as const } };
      },
    },
    "42",
    logger,
    20,
    3_000,
    {
      now: () => now,
      coldReconcileMs: 50,
      fullCatalogIntervalMs: 50,
      settleMs: 20,
      runtimeEvidence: () => runtimeEvidence,
    },
  );
  return {
    state,
    messages,
    catalog,
    observerStore,
    read,
    observer,
    sent,
    advance(ms: number) { now += ms; recency = Math.floor(now / 1000); },
    complete(text = "final result") { status = "completed"; finalText = text; recency = Math.floor(now / 1000); completedAt = recency; },
    completeWithoutTimestamp(text = "final result") { status = "completed"; finalText = text; recency = Math.floor(now / 1000); completedAt = null; },
    interrupt(text = "", timestamp: number | null = null) { status = "interrupted"; finalText = text; recency = Math.floor(now / 1000); completedAt = timestamp; },
    fail(text = "", timestamp: number | null = null) { status = "failed"; finalText = text; recency = Math.floor(now / 1000); completedAt = timestamp; },
    setRuntimeEvidence(value: typeof runtimeEvidence) { runtimeEvidence = value; },
    setCommentary(text: string | null) { commentaryText = text; },
    setFinalText(text: string) { finalText = text; },
  };
}

describe("DesktopObserver app-server history", () => {
  test("baselines a running turn and notifies when it later completes", async () => {
    const f = fixture();
    await f.observer.pollOnce();
    expect(f.sent).toEqual([]);
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.disposition).toBe("monitoring");

    f.advance(2_000);
    f.complete();
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(1);

    f.observer.start();
    await Bun.sleep(10);
    await f.observer.stop();
    expect(f.sent[0]?.text).toBe("Codex: Test thread\n状态: 执行完成\nfinal result");
    expect(f.sent[0]?.buttons).toEqual([[{ text: "💬 回复", callback_data: "reply:thread-a" }]]);
    expect(f.messages.findLink("42", 1)).toMatchObject({ threadId: "thread-a", turnId: "turn-a", eventKind: "completed" });
    await f.read.close(); f.state.close();
  });

  test("waits for delayed final text and never freezes commentary as the completed reply", async () => {
    const f = fixture();
    await f.observer.pollOnce();
    f.advance(2_000);
    f.complete("");
    f.setCommentary("Still working");
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(0);
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.contentState).toBe("pending");

    f.advance(20);
    f.setFinalText("late final");
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toMatchObject([{ text: "Codex: Test thread\n状态: 执行完成\nlate final" }]);
    f.advance(20_000);
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(1);
    await f.read.close(); f.state.close();
  });

  test("keeps timestamp-less interrupted provisional until the running turn later completes", async () => {
    const f = fixture();
    await f.observer.pollOnce();

    f.advance(400);
    f.setRuntimeEvidence({ state: "active", turnId: "turn-a", lastEvent: "PreToolUse" });
    f.interrupt();
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(0);
    expect(f.observerStore.getObservation("thread-a", "turn-a")).toMatchObject({
      lastStatus: "interrupted",
      terminalKind: null,
      contentState: "pending",
      disposition: "monitoring",
    });

    f.advance(38_000);
    f.complete("actual completed reply");
    f.setRuntimeEvidence({ state: "idle", turnId: "turn-a", lastEvent: "Stop" });
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toMatchObject([{
      turnId: "turn-a",
      eventKind: "completed",
      text: "Codex: Test thread\n状态: 执行完成\nactual completed reply",
    }]);
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.terminalKind).toBe("completed");
    await f.read.close(); f.state.close();
  });

  test("does not promote an ambiguous interrupted merely because the settle window elapsed", async () => {
    const f = fixture();
    await f.observer.pollOnce();
    f.advance(700);
    f.interrupt();
    await f.observer.pollOnce();
    f.advance(60_000);
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(0);
    expect(f.observerStore.getObservation("thread-a", "turn-a")).toMatchObject({
      lastStatus: "interrupted",
      terminalKind: null,
      contentState: "pending",
    });
    await f.read.close(); f.state.close();
  });

  test("accepts interrupted with an official completion timestamp without hook evidence", async () => {
    const f = fixture();
    await f.observer.pollOnce();
    f.advance(700);
    f.interrupt("", Math.floor(1_000_700 / 1000));
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toMatchObject([{
      turnId: "turn-a",
      eventKind: "interrupted",
      text: "Codex: Test thread\n状态: 已中断",
    }]);
    await f.read.close(); f.state.close();
  });

  test("accepts a timestamp-less interrupted only with exact runtime Interrupt evidence", async () => {
    const f = fixture();
    await f.observer.pollOnce();
    f.advance(700);
    f.setRuntimeEvidence({ state: "idle", turnId: "turn-a", lastEvent: "Interrupt" });
    f.interrupt();
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toMatchObject([{
      turnId: "turn-a",
      eventKind: "interrupted",
      text: "Codex: Test thread\n状态: 已中断",
    }]);
    await f.read.close(); f.state.close();
  });

  test("corrects a previously sent interrupted terminal when official history later proves completion", async () => {
    const f = fixture();
    await f.observer.pollOnce();
    const state = f.observerStore.getThreadState("thread-a");
    if (!state) throw new Error("thread state missing");
    const oldAt = 1_000_400;
    f.advance(400);
    f.observerStore.commitThreadRefresh({
      threadId: "thread-a",
      observations: [{
        turnId: "turn-a",
        status: "interrupted",
        terminalKind: "interrupted",
        contentState: "confirmed_empty",
        disposition: "monitoring",
        notification: { chatId: "42", eventKind: "interrupted", text: "Codex: Test thread\n状态: 已中断" },
      }],
      anchorTurnId: "turn-a",
      baselineState: "monitoring",
      monitoringStartedAt: state.monitoringStartedAt,
      nextHistoryReconcileAt: oldAt,
      lastReconciledAt: oldAt,
      lastRecencyAtMs: state.lastRecencyAtMs,
    }, oldAt);
    const wrong = f.messages.listPendingNotifications(oldAt)[0];
    if (!wrong) throw new Error("old interrupted notification missing");
    f.messages.completeNotification(wrong.eventFingerprint, 77, oldAt);
    expect(f.messages.findLink("42", 77)?.eventKind).toBe("interrupted");

    f.advance(40_000);
    f.complete("correct completed reply");
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toMatchObject([{
      turnId: "turn-a",
      eventKind: "completed",
      text: "Codex: Test thread\n状态: 执行完成\ncorrect completed reply",
    }]);
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.terminalKind).toBe("completed");
    await f.read.close(); f.state.close();
  });

  test("suppresses a bootstrap-member historical terminal even when completedAt is absent", async () => {
    const f = fixture();
    f.completeWithoutTimestamp("historical final");
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(0);
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.disposition).toBe("baseline_suppressed");
    await f.read.close(); f.state.close();
  });

  test("a turn first observed running is notified if it later becomes terminal without completedAt", async () => {
    const f = fixture();
    await f.observer.pollOnce();
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.lastStatus).toBe("inProgress");
    f.advance(2_000);
    f.completeWithoutTimestamp("late no timestamp");
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toMatchObject([{ turnId: "turn-a", text: "Codex: Test thread\n状态: 执行完成\nlate no timestamp" }]);
    await f.read.close(); f.state.close();
  });

  test("Sea-Bridge-created marker is not baseline-suppressed when completedAt is absent", async () => {
    const f = fixture({ createdBySeaBridge: true });
    f.completeWithoutTimestamp("created final");
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toMatchObject([{ turnId: "turn-a", text: "Codex: Test thread\n状态: 执行完成\ncreated final" }]);
    await f.read.close(); f.state.close();
  });

  test("suppresses a terminal turn that predates bootstrap", async () => {
    const f = fixture({ now: 10_000, initialStatus: "completed" });
    // The mock terminal completed in the same second as bootstrap by default; force bootstrap later.
    f.advance(5_000);
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(0);
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.disposition).toBe("baseline_suppressed");
    await f.read.close(); f.state.close();
  });

  test("does not baseline away the first turn created by Sea-Bridge", async () => {
    const f = fixture({ createdBySeaBridge: true, initialStatus: "completed" });
    await f.observer.pollOnce();
    expect(f.messages.listPendingNotifications()).toHaveLength(1);
    expect(f.observerStore.getObservation("thread-a", "turn-a")?.disposition).toBe("notification_enqueued");
    await f.read.close(); f.state.close();
  });

  test("tracks a nonterminal turn found on an older baseline page until it becomes terminal", async () => {
    let now = 1_000_000;
    let olderStatus: "inProgress" | "completed" = "inProgress";
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/list") return proc.send({ id: message.id, result: { data: [{
        id: "thread-pages", name: "Paged thread", path: "/tmp/pages.jsonl",
        createdAt: 800, updatedAt: 1000, recencyAt: 1000, source: "cli", originator: "codex-tui",
        parentThreadId: null, threadSource: "user",
      }], nextCursor: null } });
      if (message.method === "thread/turns/list" && message.params.cursor == null) return proc.send({ id: message.id, result: {
        data: [{ id: "newer", status: "completed", startedAt: 899, completedAt: 900, itemsView: "summary" }], nextCursor: "older",
      } });
      if (message.method === "thread/turns/list" && message.params.cursor === "older") return proc.send({ id: message.id, result: {
        data: [{ id: "older-running", status: olderStatus, startedAt: 950,
          completedAt: olderStatus === "completed" ? Math.floor(now / 1000) : null, itemsView: "summary" }], nextCursor: null,
      } });
      if (message.method === "thread/items/list") return proc.send({ id: message.id, result: { data: [{
        turnId: "older-running", item: { id: "answer", type: "agentMessage", text: "older done", phase: "final_answer" },
      }], nextCursor: null } });
    });
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    const catalog = new CodexCatalogStore(state, "/home");
    const observerStore = new CodexObserverStore(state, "/home");
    const read = new CodexReadService("/codex", "/home", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 50,
    });
    const observer = new DesktopObserver(read, catalog, observerStore, messages,
      { sendMessage: async () => ({ message_id: 1, chat: { id: 42, type: "private" as const } }) },
      "42", logger, 10, 3_000, { now: () => now, coldReconcileMs: 50 });

    await observer.pollOnce();
    expect(observerStore.getObservation("thread-pages", "older-running")?.disposition).toBe("monitoring");
    olderStatus = "completed";
    now += 20;
    await observer.pollOnce();
    expect(messages.listPendingNotifications(now)).toMatchObject([{ turnId: "older-running", text: "Codex: Paged thread\n状态: 执行完成\nolder done" }]);
    await read.close(); state.close();
  });

  test("reserves refresh capacity so sustained hot churn cannot starve a due running thread", async () => {
    let now = 1_000;
    let hotRecencySeconds = 2;
    const hotIds = Array.from({ length: 21 }, (_, index) => `hot-${index + 1}`);
    const coldId = "cold-running";
    const coldOverdueId = "cold-overdue";
    const refreshCounts = new Map<string, number>();
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/list") return proc.send({ id: message.id, result: {
        data: hotIds.map((id) => ({
          id, name: id, path: `/tmp/${id}.jsonl`, createdAt: 1, updatedAt: hotRecencySeconds,
          recencyAt: hotRecencySeconds, source: "cli", originator: "codex-tui",
          parentThreadId: null, threadSource: "user",
        })),
        nextCursor: null,
      } });
      if (message.method === "thread/turns/list") {
        const threadId = String(message.params.threadId);
        refreshCounts.set(threadId, (refreshCounts.get(threadId) ?? 0) + 1);
        return proc.send({ id: message.id, result: {
          data: threadId === coldId
            ? [{ id: "running-turn", status: "inProgress", startedAt: 1, completedAt: null, itemsView: "summary" }]
            : [],
          nextCursor: null,
        } });
      }
    });

    const state = new StateDb(":memory:");
    const catalog = new CodexCatalogStore(state, "/home");
    const observerStore = new CodexObserverStore(state, "/home");
    observerStore.ensureEnvironment(now);
    observerStore.beginBootstrap(now);
    const initialThreads = [...hotIds, coldId, coldOverdueId].map((id) => ({
      id,
      title: id,
      rolloutPath: `/tmp/${id}.jsonl`,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      recencyAtMs: 1_000,
      source: "cli",
      originator: "codex-tui",
      parentThreadId: null,
      threadSource: "user",
      creationClient: { kind: "cli" as const, evidence: "originator" as const },
    }));
    const generation = catalog.commitFull(initialThreads, now);
    observerStore.freezeInitialCatalog([...hotIds, coldId, coldOverdueId], generation, now);
    for (const id of hotIds) {
      observerStore.commitThreadRefresh({
        threadId: id,
        observations: [],
        anchorTurnId: null,
        baselineState: "monitoring",
        monitoringStartedAt: now,
        nextHistoryReconcileAt: now + 1_000_000,
        lastReconciledAt: now,
        lastRecencyAtMs: 1_000,
      }, now);
    }
    observerStore.commitThreadRefresh({
      threadId: coldOverdueId,
      observations: [],
      anchorTurnId: null,
      baselineState: "monitoring",
      monitoringStartedAt: now,
      nextHistoryReconcileAt: now,
      lastReconciledAt: now,
      lastRecencyAtMs: 1_000,
    }, now);
    observerStore.commitThreadRefresh({
      threadId: coldId,
      observations: [{
        turnId: "running-turn",
        status: "inProgress",
        terminalKind: null,
        contentState: "not_applicable",
        disposition: "monitoring",
      }],
      anchorTurnId: null,
      baselineState: "monitoring",
      monitoringStartedAt: now,
      nextHistoryReconcileAt: now,
      lastReconciledAt: now,
      lastRecencyAtMs: 1_000,
    }, now);
    observerStore.completeInitialPass(now);

    const read = new CodexReadService("/codex", "/home", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 50,
    });
    const observer = new DesktopObserver(
      read,
      catalog,
      observerStore,
      new DesktopMessageStore(state),
      { sendMessage: async () => ({ message_id: 1, chat: { id: 42, type: "private" as const } }) },
      "42",
      logger,
      20,
      3_000,
      { now: () => now, fullCatalogIntervalMs: 1_000_000, coldReconcileMs: 1_000_000, refreshBatch: 20 },
    );

    for (let poll = 0; poll < 4; poll++) {
      await observer.pollOnce();
      now += 20;
      hotRecencySeconds += 1;
    }

    expect(refreshCounts.get(coldId)).toBe(4);
    expect(refreshCounts.get(coldOverdueId)).toBe(1);
    const hotRefreshes = hotIds.reduce((sum, id) => sum + (refreshCounts.get(id) ?? 0), 0);
    expect(hotRefreshes).toBe(75);
    await read.close(); state.close();
  });

  test("keeps history reconciliation after a monitored thread disappears from the active catalog", async () => {
    let now = 1_000_000;
    let listed = true;
    let turnVisible = false;
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/list") return proc.send({ id: message.id, result: { data: listed ? [{
        id: "thread-gone", name: "Gone thread", path: "/tmp/gone.jsonl",
        createdAt: 900, updatedAt: 1000, recencyAt: 1000, source: "cli", originator: "codex-tui",
        parentThreadId: null, threadSource: "user",
      }] : [], nextCursor: null } });
      if (message.method === "thread/turns/list") return proc.send({ id: message.id, result: { data: turnVisible ? [{
        id: "turn-late", status: "completed", startedAt: 1000, completedAt: Math.floor(now / 1000), itemsView: "summary",
      }] : [], nextCursor: null } });
      if (message.method === "thread/items/list") return proc.send({ id: message.id, result: { data: [{
        turnId: "turn-late", item: { id: "answer", type: "agentMessage", text: "late result", phase: "final_answer" },
      }], nextCursor: null } });
    });
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    const catalog = new CodexCatalogStore(state, "/home");
    const observerStore = new CodexObserverStore(state, "/home");
    const read = new CodexReadService("/codex", "/home", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 50,
    });
    const observer = new DesktopObserver(read, catalog, observerStore, messages,
      { sendMessage: async () => ({ message_id: 1, chat: { id: 42, type: "private" as const } }) },
      "42", logger, 10, 3_000, { now: () => now, fullCatalogIntervalMs: 1, coldReconcileMs: 1 });

    await observer.pollOnce();
    listed = false;
    now += 10; await observer.pollOnce();
    now += 10; await observer.pollOnce();
    expect(catalog.getThread("thread-gone")).toBeNull();

    turnVisible = true;
    now += 10; await observer.pollOnce();
    expect(messages.listPendingNotifications(now)).toHaveLength(1);
    expect(observerStore.getObservation("thread-gone", "turn-late")?.disposition).toBe("notification_enqueued");
    await read.close(); state.close();
  });

  test("delivers an existing outbox entry even while catalog polling fails", async () => {
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    messages.enqueueNotification({ chatId: "42", threadId: "thread", turnId: "turn", eventKind: "completed", eventFingerprint: "legacy", text: "legacy notification" }, 1);
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/list") return proc.send({ id: message.id, error: { code: -32000, message: "offline" } });
    });
    const read = new CodexReadService("/codex", "/home", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 50,
    });
    const observer = new DesktopObserver(
      read,
      new CodexCatalogStore(state, "/home"),
      new CodexObserverStore(state, "/home"),
      messages,
      { sendMessage: async () => ({ message_id: 9, chat: { id: 42, type: "private" as const } }) },
      "42", logger, 20, 3_000,
    );
    observer.start();
    await Bun.sleep(15);
    await observer.stop();
    expect(messages.listPendingNotifications(Date.now() + 1_000)).toHaveLength(0);
    expect(messages.findLink("42", 9)?.threadId).toBe("thread");
    await read.close(); state.close();
  });
});

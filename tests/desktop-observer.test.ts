import { describe, expect, test } from "bun:test";
import { DesktopObserver } from "../src/desktop/desktop-observer.ts";
import type { CodexThread } from "../src/desktop/codex-thread-store.ts";
import type { Logger } from "../src/logger.ts";
import type { ThreadHistoryReader } from "../src/desktop/thread-history-store.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { StateDb } from "../src/state/db.ts";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("DesktopObserver", () => {
  test("keeps the entire notification within Telegram's message limit", async () => {
    const thread: CodexThread = { id: "thread-long", rolloutPath: "history://thread-long", title: "会话标题".repeat(500), updatedAtMs: 1 };
    const history: ThreadHistoryReader = {
      latestOrdinal: () => 20,
      latestOrdinals: () => new Map(),
      listTurnsAfter: () => [{
        threadId: "thread-long",
        turnId: "turn-long",
        ordinal: 20,
        status: "completed",
        completedAtMs: 1,
        finalText: "回复正文".repeat(1_500),
      }],
    };
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    const sent: string[] = [];
    const observer = new DesktopObserver(
      { listActive: () => [thread] },
      history,
      messages,
      { sendMessage: async (_chatId, text) => {
        sent.push(text);
        return { message_id: 1, chat: { id: 42, type: "private" } };
      } },
      "42",
      logger,
      5_000,
      3_000,
    );

    await observer.pollOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBeLessThanOrEqual(4_000);
    expect(sent[0]).toContain("内容已截断");
    state.close();
  });

  test("continues delivering other threads when one Telegram notification fails", async () => {
    const threads: CodexThread[] = [
      { id: "thread-fails", rolloutPath: "history://thread-fails", title: "失败会话", updatedAtMs: 1 },
      { id: "thread-succeeds", rolloutPath: "history://thread-succeeds", title: "正常会话", updatedAtMs: 1 },
    ];
    const history: ThreadHistoryReader = {
      latestOrdinal: () => 20,
      latestOrdinals: () => new Map(),
      listTurnsAfter: (threadId) => [{
        threadId,
        turnId: `turn-${threadId}`,
        ordinal: 20,
        status: "completed",
        completedAtMs: 1,
        finalText: "result",
      }],
    };
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    const attempted: string[] = [];
    const observer = new DesktopObserver(
      { listActive: () => threads },
      history,
      messages,
      { sendMessage: async (_chatId, text) => {
        attempted.push(text);
        if (text.includes("失败会话")) throw new Error("temporary Telegram failure");
        return { message_id: 2, chat: { id: 42, type: "private" } };
      } },
      "42",
      logger,
      5_000,
      3_000,
    );

    await observer.pollOnce();

    expect(new Set(attempted)).toEqual(new Set([
      "Codex: 失败会话\n状态: 执行完成\nresult",
      "Codex: 正常会话\n状态: 执行完成\nresult",
    ]));
    expect(messages.findLink("42", 2)?.threadId).toBe("thread-succeeds");
    expect(messages.listPendingNotifications(Date.now() + 6_000)).toHaveLength(1);
    state.close();
  });

  test("baselines paginated history then maps a new final reply to the Desktop thread", async () => {
    const thread: CodexThread = { id: "thread-a", rolloutPath: "history://thread-a", title: "Test thread", updatedAtMs: 1 };
    let includeNewTurn = false;
    const history: ThreadHistoryReader = {
      latestOrdinal: () => includeNewTurn ? 20 : 10,
      latestOrdinals: () => new Map([["thread-a", 10]]),
      listTurnsAfter: (_threadId, ordinal) => includeNewTurn && ordinal < 20
        ? [{ threadId: "thread-a", turnId: "turn-a", ordinal: 20, status: "completed", completedAtMs: 1, finalText: "final result" }]
        : [],
    };
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    const sent: string[] = [];
    let capturedButtons: any;
    let capturedForceReply: any;
    const observer = new DesktopObserver(
      { listActive: () => [thread] },
      history,
      messages,
      {
        sendMessage: async (_chatId, text, buttons, forceReply) => {
          capturedButtons = buttons;
          capturedForceReply = forceReply;
          return { message_id: sent.push(text), chat: { id: 42, type: "private" } };
        },
      },
      "42",
      logger,
      5_000,
      3_000,
    );

    await observer.pollOnce();
    includeNewTurn = true;
    await observer.pollOnce();

    expect(sent).toEqual(["Codex: Test thread\n状态: 执行完成\nfinal result"]);
    expect(capturedButtons).toEqual([[{ text: "💬 回复", callback_data: "reply:thread-a" }]]);
    expect(capturedForceReply).toBe(false);
    expect(messages.findLink("42", 1)).toMatchObject({ threadId: "thread-a", eventKind: "completed", turnId: "turn-a" });
    state.close();
  });

  test("observes the first completed turn for a Sea-Bridge-created thread instead of baselining it away", async () => {
    const thread: CodexThread = { id: "thread-new", rolloutPath: "history://thread-new", title: "New thread", updatedAtMs: 1 };
    const history: ThreadHistoryReader = {
      latestOrdinal: () => 20,
      latestOrdinals: () => new Map(),
      listTurnsAfter: (_threadId, ordinal) => ordinal < 20
        ? [{ threadId: "thread-new", turnId: "turn-first", ordinal: 20, status: "completed", completedAtMs: 1, finalText: "first result" }]
        : [],
    };
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    messages.registerCreatedThread("thread-new");
    const sent: string[] = [];
    const observer = new DesktopObserver(
      { listActive: () => [thread] },
      history,
      messages,
      {
        sendMessage: async (_chatId, text) => ({
          message_id: 100 + sent.push(text),
          chat: { id: 42, type: "private" },
        }),
      },
      "42",
      logger,
      5_000,
      3_000,
    );

    await observer.pollOnce();

    expect(sent).toEqual(["Codex: New thread\n状态: 执行完成\nfirst result"]);
    expect(messages.getCursor("thread-new")?.byteOffset).toBe(20);
    state.close();
  });
});

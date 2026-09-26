import { describe, expect, test } from "bun:test";
import { DesktopObserver } from "../src/desktop/desktop-observer.ts";
import type { CodexThread } from "../src/desktop/codex-thread-store.ts";
import type { Logger } from "../src/logger.ts";
import type { ThreadHistoryReader } from "../src/desktop/thread-history-store.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { StateDb } from "../src/state/db.ts";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("DesktopObserver", () => {
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

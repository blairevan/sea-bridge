import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";

describe("DesktopMessageStore", () => {
  test("maps one Telegram notification to one Desktop thread", () => {
    const state = new StateDb(":memory:");
    const store = new DesktopMessageStore(state);
    store.link({
      chatId: "42",
      messageId: 99,
      threadId: "thread-a",
      turnId: "turn-1",
      eventKind: "completed",
      eventFingerprint: "event-1",
    });
    expect(store.findLink("42", 99)?.threadId).toBe("thread-a");
    state.close();
  });

  test("claims a Telegram reply update only once", () => {
    const state = new StateDb(":memory:");
    const store = new DesktopMessageStore(state);
    expect(store.beginDelivery(101, 99, "thread-a", "text-hash")).toBe("new");
    expect(store.beginDelivery(101, 99, "thread-a", "text-hash")).toBe("duplicate");
    state.close();
  });

  test("records a terminal delivery result exactly once", () => {
    const state = new StateDb(":memory:");
    const store = new DesktopMessageStore(state);
    store.beginDelivery(101, 99, "thread-a", "text-hash");
    expect(store.finishDelivery(101, "delivered", 0)).toBe(true);
    expect(store.finishDelivery(101, "failed", 1, "nonzero_exit")).toBe(false);
    expect(store.getDelivery(101)).toEqual({
      updateId: 101,
      threadId: "thread-a",
      status: "delivered",
      exitCode: 0,
      errorCode: null,
    });
    state.close();
  });

  test("finds the latest message link for a given chat", () => {
    const state = new StateDb(":memory:");
    const store = new DesktopMessageStore(state);

    expect(store.findLatestLink("chat-1")).toBeNull();

    store.link({ chatId: "chat-1", messageId: 10, threadId: "thread-1", turnId: "turn-1", eventKind: "started", eventFingerprint: "fp-1" });
    store.link({ chatId: "chat-1", messageId: 20, threadId: "thread-2", turnId: "turn-2", eventKind: "completed", eventFingerprint: "fp-2" });
    store.link({ chatId: "chat-2", messageId: 30, threadId: "thread-3", turnId: "turn-3", eventKind: "completed", eventFingerprint: "fp-3" });

    const latest1 = store.findLatestLink("chat-1");
    expect(latest1?.threadId).toBe("thread-2");
    expect(latest1?.messageId).toBe(20);

    const latest2 = store.findLatestLink("chat-2");
    expect(latest2?.threadId).toBe("thread-3");
    expect(latest2?.messageId).toBe(30);

    state.close();
  });
});

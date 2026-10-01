import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshSessionObserver } from "../src/dsh/session-observer.ts";
import type { DshEventMetadata, DshHistoryPage } from "../src/dsh/types.ts";

/** Build synthetic metadata-only Host pages. */
function page(events: DshEventMetadata[], hasMore = false): DshHistoryPage {
  return { events, hasMore, truncated: false };
}

function summary(text: string | null = null, assistantSeq = 0) {
  return {
    getTurnSummary: async (_sessionId: string, turn: number) => ({
      turn,
      assistantSeq: text === null ? null : assistantSeq,
      assistantText: text,
    }),
  };
}

/** Create an in-memory store isolated from Codex state. */
function state(): { db: StateDb; store: DshBridgeStore } {
  const db = new StateDb(":memory:");
  return { db, store: new DshBridgeStore(db) };
}

describe("DshSessionObserver", () => {
  test("baselines an existing session, then enqueues one verified completion only", async () => {
    const { db, store } = state();
    try {
      let cursor = 4;
      let events: DshEventMetadata[] = [];
      const host = {
        listSessions: async () => [{ sessionId: "session-1", updatedAt: 1, running: false, blank: false }],
        followSnapshot: async () => ({ cursor, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page(events),
        ...summary("完整回答", 4),
      };
      const sent: string[] = [];
      const observer = new DshSessionObserver(host, store, { sendMessage: async (_chat, text) => {
        sent.push(text); return { message_id: 8 };
      } }, "one-chat");
      await observer.pollOnce();
      expect(store.getObserverState("session-1")?.cursor).toBe(4);
      cursor = 5;
      events = [{ type: "turn/end", seq: 5, time: 1, turn: 1, reasonKind: "completed" }];
      await observer.pollOnce();
      await observer.pollOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("dsh Web");
      expect(sent[0]).toContain("完整回答");
      expect(store.getObserverState("session-1")?.cursor).toBe(5);
      expect(store.findMessageLink("one-chat", 8)?.sessionId).toBe("session-1");
    } finally { db.close(); }
  });

  test("created session does not baseline away its first completed turn", async () => {
    const { db, store } = state();
    try {
      store.registerCreatedSession("session-new", 77);
      const host = {
        listSessions: async () => [{ sessionId: "session-new", updatedAt: 1, running: false, blank: false, title: "新会话" }],
        followSnapshot: async () => ({ cursor: 0, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([{ type: "turn/end", seq: 0, time: 1, turn: 1, reasonKind: "completed" }]),
        ...summary(null),
      };
      const observer = new DshSessionObserver(host, store, { sendMessage: async () => ({ message_id: 9 }) }, "one-chat");
      await observer.pollOnce();
      expect(store.getCreatedSession("session-new")?.baselinePending).toBe(false);
      expect(store.findMessageLink("one-chat", 9)?.sessionId).toBe("session-new");
    } finally { db.close(); }
  });

  test("a creation marker arriving during snapshot prevents an ordinary baseline", async () => {
    const { db, store } = state();
    try {
      const actualMarker = store.getCreatedSession.bind(store);
      let markerReads = 0;
      store.getCreatedSession = (sessionId: string) => (++markerReads === 1 ? null : actualMarker(sessionId));
      const host = {
        listSessions: async () => [{ sessionId: "session-new", updatedAt: 1, running: false, blank: false }],
        followSnapshot: async () => {
          store.registerCreatedSession("session-new", 79);
          return { cursor: 0, hasMore: false, truncated: false, events: [] };
        },
        pageHistory: async () => page([{ type: "turn/end", seq: 0, time: 1, turn: 1, reasonKind: "completed" }]),
        ...summary(null),
      };
      const observer = new DshSessionObserver(host, store, { sendMessage: async () => ({ message_id: 19 }) }, "one-chat");
      await expect(observer.pollOnce()).rejects.toThrow("dsh_observer_cursor_conflict");
      expect(store.getObserverState("session-new")).toBeNull();
      await observer.pollOnce();
      expect(store.findMessageLink("one-chat", 19)?.sessionId).toBe("session-new");
    } finally { db.close(); }
  });

  test("gap does not advance a persisted cursor or enqueue a notification", async () => {
    const { db, store } = state();
    try {
      store.saveObserverState({ sessionId: "session-1", cursor: 2,
        contractFingerprint: "dsh-web-0.1.7-rc.2-metadata-v1", lastEventFingerprint: null });
      const host = {
        listSessions: async () => [{ sessionId: "session-1", updatedAt: 1, running: false, blank: false }],
        followSnapshot: async () => ({ cursor: 4, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([{ type: "test/event", seq: 2, time: 1 },
          { type: "turn/end", seq: 4, time: 1, turn: 1, reasonKind: "completed" }]),
        ...summary(null),
      };
      const observer = new DshSessionObserver(host, store, { sendMessage: async () => ({ message_id: 10 }) }, "one-chat");
      await expect(observer.pollOnce()).rejects.toThrow("recovery_gap");
      expect(store.getObserverState("session-1")?.cursor).toBe(2);
      expect(store.listPendingNotifications()).toHaveLength(0);
    } finally { db.close(); }
  });

  test("does not advance the cursor when exact-turn assistant text cannot be projected", async () => {
    const { db, store } = state();
    try {
      store.saveObserverState({ sessionId: "session-1", cursor: 0,
        contractFingerprint: "dsh-web-0.1.7-rc.2-metadata-v1", lastEventFingerprint: null });
      const host = {
        listSessions: async () => [{ sessionId: "session-1", updatedAt: 1, running: false, blank: false }],
        followSnapshot: async () => ({ cursor: 1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([{ type: "turn/end", seq: 1, time: 1, turn: 1,
          reasonKind: "completed" }]),
        getTurnSummary: async () => { throw new Error("summary unavailable"); },
      };
      const observer = new DshSessionObserver(host, store,
        { sendMessage: async () => ({ message_id: 11 }) }, "one-chat");
      await expect(observer.pollOnce()).rejects.toThrow("summary unavailable");
      expect(store.getObserverState("session-1")).toMatchObject({
        cursor: 0,
        contractFingerprint: "dsh-web-0.1.7-rc.2-terminal-text-v2",
      });
      expect(store.listPendingNotifications()).toEqual([]);
    } finally { db.close(); }
  });

  test("terminal failure/interruption/unknown outcomes advance the cursor with safe notifications", async () => {
    for (const reasonKind of ["error", "aborted", "interrupted", "max-tokens", "unknown"] as const) {
      const { db, store } = state();
      try {
        store.saveObserverState({ sessionId: "session-1", cursor: 0,
          contractFingerprint: "dsh-web-0.1.7-rc.2-metadata-v1", lastEventFingerprint: null });
        const host = {
          listSessions: async () => [{ sessionId: "session-1", updatedAt: 1, running: false, blank: false }],
          followSnapshot: async () => ({ cursor: 1, hasMore: false, truncated: false, events: [] }),
          pageHistory: async () => page([{ type: "turn/end", seq: 1, time: 1, turn: 1, reasonKind }]),
          ...summary(reasonKind === "interrupted" ? "已生成的部分回答" : null),
        };
        const sent: string[] = [];
        const observer = new DshSessionObserver(host, store, { sendMessage: async (_chat, text) => {
          sent.push(text);
          return { message_id: 12 };
        } }, "one-chat");
        await observer.pollOnce();
        expect(store.getObserverState("session-1")?.cursor).toBe(1);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("状态:");
      } finally { db.close(); }
    }
  });

  test("sends a titled long final answer in order, maps every chunk, and puts the reply button only on the last chunk", async () => {
    const { db, store } = state();
    try {
      store.saveObserverState({ sessionId: "session-long", cursor: 0,
        contractFingerprint: "dsh-web-0.1.7-rc.2-metadata-v1", lastEventFingerprint: null });
      const answer = "甲".repeat(3_500) + "\n" + "乙".repeat(3_500);
      const host = {
        listSessions: async () => [{ sessionId: "session-long", updatedAt: 1, running: false,
          blank: false, title: "长回答会话" }],
        followSnapshot: async () => ({ cursor: 1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([{ type: "turn/end", seq: 1, time: 1, turn: 9,
          reasonKind: "completed" }]),
        getTurnSummary: async () => ({ turn: 9, assistantSeq: 0, assistantText: answer }),
      };
      const sent: Array<{ text: string; buttons: unknown[][] | undefined; messageId: number }> = [];
      const observer = new DshSessionObserver(host, store, { sendMessage: async (_chat, text, buttons) => {
        const messageId = 30 + sent.length;
        sent.push({ text, buttons, messageId });
        return { message_id: messageId };
      } }, "one-chat", 10_000, true);
      await observer.pollOnce();

      expect(sent.length).toBeGreaterThan(1);
      expect(sent[0]?.text).toContain("dsh Web: 长回答会话");
      expect(sent[0]?.text).toContain("状态: 执行完成");
      expect(sent.every((item) => item.text.length <= 4_000)).toBe(true);
      expect(sent.slice(0, -1).every((item) => item.buttons === undefined)).toBe(true);
      expect(sent.at(-1)?.buttons).toBeDefined();
      for (const item of sent) {
        expect(store.findMessageLink("one-chat", item.messageId)?.sessionId).toBe("session-long");
      }
      expect(store.getObserverState("session-long")).toMatchObject({
        cursor: 1,
        contractFingerprint: "dsh-web-0.1.7-rc.2-terminal-text-v2",
      });
    } finally { db.close(); }
  });

  test("stops later chunks when an earlier Telegram chunk is rate-limited", async () => {
    const { db, store } = state();
    try {
      store.enqueueNotification({ eventFingerprint: "part-1", chatId: "one-chat", sessionId: "session-1",
        eventKind: "completed_part", text: "part one" }, 100, 100);
      store.enqueueNotification({ eventFingerprint: "part-2", chatId: "one-chat", sessionId: "session-1",
        eventKind: "completed", text: "part two" }, 100, 101);
      let sends = 0;
      const observer = new DshSessionObserver({ listSessions: async () => [],
        followSnapshot: async () => ({ cursor: -1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([]),
      }, store, { sendMessage: async () => {
        sends++;
        throw Object.assign(new Error("rate limited"), { code: 429 });
      } }, "one-chat", 10_000, true);
      await observer.pollOnce();
      expect(sends).toBe(1);
      await observer.pollOnce();
      expect(sends).toBe(1);
      expect(store.listPendingNotifications(Date.now() + 400_000).map((item) => item.text))
        .toEqual(["part one", "part two"]);
    } finally { db.close(); }
  });

  test("write-enabled notifications use only an opaque dsh reply token", async () => {
    const { db, store } = state();
    try {
      store.enqueueNotification({ eventFingerprint: "reply-event", chatId: "one-chat", sessionId: "private-session-id",
        eventKind: "completed", text: "dsh Web: 会话" });
      let callbackData = "";
      const observer = new DshSessionObserver({ listSessions: async () => [],
        followSnapshot: async () => ({ cursor: -1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([]),
      }, store, { sendMessage: async (_chat, _text, buttons) => {
        callbackData = buttons?.[0]?.[0]?.callback_data ?? "";
        return { message_id: 15 };
      } }, "one-chat", 10_000, true);
      await observer.pollOnce();
      expect(callbackData).toMatch(/^dsh:[A-Za-z0-9_-]+$/);
      expect(callbackData).not.toContain("private-session-id");
      expect(callbackData.length).toBeLessThanOrEqual(64);
    } finally { db.close(); }
  });

  test("isolates one broken session and retries a Telegram failure from the outbox", async () => {
    const { db, store } = state();
    try {
      store.saveObserverState({ sessionId: "broken", cursor: 0,
        contractFingerprint: "dsh-web-0.1.7-rc.2-metadata-v1", lastEventFingerprint: null });
      store.saveObserverState({ sessionId: "working", cursor: 0,
        contractFingerprint: "dsh-web-0.1.7-rc.2-metadata-v1", lastEventFingerprint: null });
      const host = {
        listSessions: async () => ["broken", "working"].map((sessionId) => ({
          sessionId, updatedAt: 1, running: false, blank: false,
        })),
        followSnapshot: async (sessionId: string) => ({ cursor: sessionId === "broken" ? 2 : 1,
          hasMore: false, truncated: false, events: [] }),
        pageHistory: async (sessionId: string) => page(sessionId === "broken"
          ? [{ type: "test/event", seq: 2, time: 1 }]
          : [{ type: "turn/end", seq: 1, time: 1, turn: 1, reasonKind: "completed" }]),
        ...summary(null),
      };
      let calls = 0;
      const observer = new DshSessionObserver(host, store, { sendMessage: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("rate limited"), { code: 429 });
        return { message_id: 13 };
      } }, "one-chat");
      await expect(observer.pollOnce()).rejects.toThrow("recovery_exhausted");
      expect(store.getObserverState("broken")?.cursor).toBe(0);
      expect(store.getObserverState("working")?.cursor).toBe(1);
      expect(store.listPendingNotifications(Date.now() + 400_000)).toHaveLength(1);
      store.markNotificationFailed(store.listPendingNotifications(Date.now() + 400_000)[0]!.eventFingerprint,
        "retry", 0);
      await expect(observer.pollOnce()).rejects.toThrow("recovery_exhausted");
      expect(store.findMessageLink("one-chat", 13)?.sessionId).toBe("working");
      expect(db.db.query("SELECT COUNT(*) AS count FROM dsh_callback_tokens").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  test("quarantines a sent message on mapping conflict instead of sending it twice", async () => {
    const { db, store } = state();
    try {
      store.enqueueNotification({ eventFingerprint: "new-event", chatId: "one-chat", sessionId: "session-1",
        eventKind: "completed", text: "dsh Web: 会话" });
      store.linkMessage({ chatId: "one-chat", messageId: 21, sessionId: "other-session",
        eventKind: "completed", eventFingerprint: "other-event" });
      let sends = 0;
      let callbackToken = "";
      const observer = new DshSessionObserver({ listSessions: async () => [],
        followSnapshot: async () => ({ cursor: -1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([]),
      }, store, { sendMessage: async (_chat, _text, buttons) => {
        sends++;
        const data = buttons?.[0]?.[0]?.callback_data ?? "";
        callbackToken = data.startsWith("dsh:") ? data.slice(4) : "";
        return { message_id: 21 };
      } }, "one-chat", 10_000, true);
      await observer.pollOnce();
      await observer.pollOnce();
      expect(sends).toBe(1);
      expect(store.findMessageLink("one-chat", 21)?.sessionId).toBe("other-session");
      expect(store.listPendingNotifications(Date.now() + 400_000)).toHaveLength(0);
      const row = db.db.query("SELECT status,last_error,telegram_message_id FROM dsh_notification_outbox WHERE event_fingerprint=?")
        .get("new-event") as { status: string; last_error: string; telegram_message_id: number };
      expect(row).toEqual({ status: "pending", last_error: "mapping_unknown", telegram_message_id: 21 });
      expect(callbackToken).not.toBe("");
      expect(store.getCallbackStatus(callbackToken)).toBe("expired");
    } finally { db.close(); }
  });

  test("stop aborts an active Host poll and waits for it to unwind", async () => {
    const { db, store } = state();
    try {
      let aborted = false;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const host = {
        listSessions: async (signal?: AbortSignal) => {
          started();
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              aborted = true;
              reject(new Error("aborted"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          return [];
        },
        followSnapshot: async () => ({ cursor: -1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([]),
      };
      const observer = new DshSessionObserver(host, store, { sendMessage: async () => ({ message_id: 1 }) }, "one-chat", 60_000);
      observer.start();
      await startedPromise;
      await observer.stop();
      expect(aborted).toBe(true);
    } finally { db.close(); }
  });

  test("quarantines an ambiguous Telegram transport failure instead of replaying", async () => {
    const { db, store } = state();
    try {
      store.enqueueNotification({ eventFingerprint: "uncertain-event", chatId: "one-chat", sessionId: "session-1",
        eventKind: "completed", text: "dsh Web: 会话" });
      let sends = 0;
      const observer = new DshSessionObserver({ listSessions: async () => [],
        followSnapshot: async () => ({ cursor: -1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([]),
      }, store, { sendMessage: async () => { sends++; throw new Error("connection closed after send"); } }, "one-chat");
      await observer.pollOnce();
      await observer.pollOnce();
      expect(sends).toBe(1);
      expect(store.listPendingNotifications(Date.now() + 400_000)).toHaveLength(0);
      const row = db.db.query("SELECT status,last_error FROM dsh_notification_outbox WHERE event_fingerprint=?")
        .get("uncertain-event") as { status: string; last_error: string };
      expect(row).toEqual({ status: "pending", last_error: "telegram_delivery_unknown" });
    } finally { db.close(); }
  });
});

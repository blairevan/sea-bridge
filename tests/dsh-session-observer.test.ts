import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshSessionObserver } from "../src/dsh/session-observer.ts";
import type { DshEventMetadata, DshHistoryPage } from "../src/dsh/types.ts";

/** Build synthetic metadata-only Host pages. */
function page(events: DshEventMetadata[], hasMore = false): DshHistoryPage {
  return { events, hasMore, truncated: false };
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
      };
      const sent: string[] = [];
      const observer = new DshSessionObserver(host, store, { sendMessage: async (_chat, text) => {
        sent.push(text); return { message_id: 8 };
      } }, "one-chat");
      await observer.pollOnce();
      expect(store.getObserverState("session-1")?.cursor).toBe(4);
      cursor = 5;
      events = [{ type: "turn/end", seq: 5, time: 1, reasonKind: "completed" }];
      await observer.pollOnce();
      await observer.pollOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("dsh Web");
      expect(store.getObserverState("session-1")?.cursor).toBe(5);
      expect(store.findMessageLink("one-chat", 8)?.sessionId).toBe("session-1");
    } finally { db.close(); }
  });

  test("created session does not baseline away its first completed turn", async () => {
    const { db, store } = state();
    try {
      store.registerCreatedSession("session-new", 77);
      const host = {
        listSessions: async () => [{ sessionId: "session-new", updatedAt: 1, running: false, blank: false }],
        followSnapshot: async () => ({ cursor: 0, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([{ type: "turn/end", seq: 0, time: 1, reasonKind: "completed" }]),
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
        pageHistory: async () => page([{ type: "turn/end", seq: 0, time: 1, reasonKind: "completed" }]),
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
          { type: "turn/end", seq: 4, time: 1, reasonKind: "completed" }]),
      };
      const observer = new DshSessionObserver(host, store, { sendMessage: async () => ({ message_id: 10 }) }, "one-chat");
      await expect(observer.pollOnce()).rejects.toThrow("recovery_gap");
      expect(store.getObserverState("session-1")?.cursor).toBe(2);
      expect(store.listPendingNotifications()).toHaveLength(0);
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
          pageHistory: async () => page([{ type: "turn/end", seq: 1, time: 1, reasonKind }]),
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
          : [{ type: "turn/end", seq: 1, time: 1, reasonKind: "completed" }]),
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
      const observer = new DshSessionObserver({ listSessions: async () => [],
        followSnapshot: async () => ({ cursor: -1, hasMore: false, truncated: false, events: [] }),
        pageHistory: async () => page([]),
      }, store, { sendMessage: async () => { sends++; return { message_id: 21 }; } }, "one-chat");
      await observer.pollOnce();
      await observer.pollOnce();
      expect(sends).toBe(1);
      expect(store.findMessageLink("one-chat", 21)?.sessionId).toBe("other-session");
      expect(store.listPendingNotifications(Date.now() + 400_000)).toHaveLength(0);
      const row = db.db.query("SELECT status,last_error,telegram_message_id FROM dsh_notification_outbox WHERE event_fingerprint=?")
        .get("new-event") as { status: string; last_error: string; telegram_message_id: number };
      expect(row).toEqual({ status: "pending", last_error: "mapping_unknown", telegram_message_id: 21 });
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

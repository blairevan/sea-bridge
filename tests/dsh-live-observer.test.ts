import { expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshSessionObserver } from "../src/dsh/session-observer.ts";
import type { DshEventMetadata, DshLiveWindow } from "../src/dsh/types.ts";

/** Wait for an observable condition with a bounded failure rather than a long polling interval. */
async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

/** Simulate only the external Host boundary; storage, recovery, scheduling and delivery stay real. */
function fixture() {
  const db = new StateDb(":memory:");
  const store = new DshBridgeStore(db);
  let cursor = -1;
  let events: DshEventMetadata[] = [];
  let window: ((result: DshLiveWindow) => void) | null = null;
  let sends = 0;
  let activeWindows = 0;
  const host = {
    listSessions: async () => [{ sessionId: "session-live", updatedAt: 1, running: false, blank: false }],
    followSnapshot: async () => ({ cursor, hasMore: false, truncated: false, events: [] }),
    pageHistory: async () => ({ events, hasMore: false, truncated: false }),
    getTurnSummary: async (_sessionId: string, turn: number) => ({
      turn, assistantSeq: 2 * (turn - 1), assistantText: "visible reply",
    }),
    followWindow: async (_sessionId: string, signal?: AbortSignal): Promise<DshLiveWindow> => {
      activeWindows++;
      try {
        return await new Promise<DshLiveWindow>((resolve, reject) => {
          const abort = () => { window = null; reject(new Error("aborted")); };
          signal?.addEventListener("abort", abort, { once: true });
          window = (result) => {
            signal?.removeEventListener("abort", abort);
            window = null;
            resolve(result);
          };
        });
      } finally { activeWindows--; }
    },
  };
  const observer = new DshSessionObserver(host, store, {
    sendMessage: async () => { sends++; return { message_id: 100 + sends }; },
  }, "test-chat", 60_000);
  return {
    db, store, observer, host,
    ready: () => window !== null,
    sends: () => sends,
    activeWindows: () => activeWindows,
    complete: (observed: boolean, turn = 1) => {
      cursor = 2 * turn - 1;
      events.push(
        { type: "assistant/message", seq: cursor - 1, time: 1 },
        { type: "turn/end", seq: cursor, time: 2, turn, reasonKind: "completed" },
      );
      window?.(observed
        ? { observed: true, cursor: cursor - 1, event: events.at(-1)! }
        : { observed: false, cursor });
    },
  };
}

test("live terminal wake delivers without waiting for the periodic scan and never duplicates", async () => {
  const f = fixture();
  try {
    await f.observer.pollOnce();
    f.observer.start();
    await until(f.ready);
    f.complete(true);
    await until(() => f.sends() === 1);
    await f.observer.pollOnce();
    expect(f.sends()).toBe(1);
    expect(f.store.findMessageLink("test-chat", 101)?.sessionId).toBe("session-live");
    await f.observer.stop();
    expect(f.activeWindows()).toBe(0);
  } finally { await f.observer.stop(); f.db.close(); }
});

test("a reopened window cursor recovers a terminal missed between subscriptions", async () => {
  const f = fixture();
  try {
    await f.observer.pollOnce();
    f.observer.start();
    await until(f.ready);
    f.complete(false);
    await until(() => f.sends() === 1);
    expect(f.store.getObserverState("session-live")?.cursor).toBe(1);
  } finally { await f.observer.stop(); f.db.close(); }
});

test("a failed live subscription leaves periodic recovery and exact reply mapping available", async () => {
  const f = fixture();
  f.host.followWindow = async () => { throw new Error("Host offline"); };
  let sent = false;
  const observer = new DshSessionObserver(f.host, f.store, {
    sendMessage: async () => { sent = true; return { message_id: 202 }; },
  }, "test-chat", 20);
  try {
    await observer.pollOnce();
    observer.start();
    await until(() => observer.getStatus().liveReconnecting === 1);
    f.complete(false);
    await until(() => sent);
    expect(f.store.findMessageLink("test-chat", 202)?.sessionId).toBe("session-live");
  } finally { await observer.stop(); f.db.close(); }
});

test("a failed window reconnects and resumes immediate delivery before the fallback interval", async () => {
  const f = fixture();
  const follow = f.host.followWindow;
  let offline = true;
  f.host.followWindow = async (id, signal) => {
    if (offline) throw new Error("connection lost");
    return await follow(id, signal);
  };
  try {
    await f.observer.pollOnce();
    f.observer.start();
    await until(() => f.observer.getStatus().liveReconnecting === 1);
    offline = false;
    await until(f.ready, 2_000);
    f.complete(true);
    await until(() => f.sends() === 1);
    expect(f.observer.getStatus().liveReconnecting).toBe(0);
    expect(f.store.findMessageLink("test-chat", 101)?.sessionId).toBe("session-live");
  } finally { await f.observer.stop(); f.db.close(); }
});

test("session removal cancels its live window before shutdown", async () => {
  const f = fixture();
  try {
    await f.observer.pollOnce();
    f.observer.start();
    await until(f.ready);
    f.host.listSessions = async () => [];
    await f.observer.pollOnce();
    await until(() => f.activeWindows() === 0);
    expect(f.observer.getStatus().liveSubscriptions).toBe(0);
  } finally { await f.observer.stop(); f.db.close(); }
});

test("a live event arriving during delivery gets an immediate second reconciliation", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  const observer = new DshSessionObserver(f.host, f.store, {
    sendMessage: async () => {
      sends++;
      if (sends === 1) await held;
      return { message_id: 300 + sends };
    },
  }, "test-chat", 60_000);
  try {
    await observer.pollOnce();
    observer.start();
    await until(f.ready);
    f.complete(true);
    await until(() => sends === 1 && f.ready());
    f.complete(true, 2);
    release();
    await until(() => sends === 2);
    expect(f.store.getObserverState("session-live")?.cursor).toBe(3);
    expect(f.store.findMessageLink("test-chat", 302)?.sessionId).toBe("session-live");
  } finally { release(); await observer.stop(); f.db.close(); }
});

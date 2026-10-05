import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { CodexObserverStore, terminalCorrectionFingerprint, terminalFingerprint } from "../src/state/codex-observer-store.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";

function initialize(store: CodexObserverStore, now = 1_000): void {
  expect(store.ensureEnvironment(now)).toBe("ready");
  store.beginBootstrap(now);
  store.freezeInitialCatalog(["thread"], 1, now);
}

describe("CodexObserverStore", () => {
  test("terminal identity deduplicates across historical chats and old fingerprints", () => {
    const state = new StateDb(":memory:");
    const store = new CodexObserverStore(state, "/home");
    initialize(store);
    state.db.query(`
      INSERT INTO desktop_message_links(
        telegram_chat_id,telegram_message_id,thread_id,turn_id,event_kind,event_fingerprint,sent_at
      ) VALUES('old-chat',1,'thread','turn','completed','legacy-fingerprint',1)
    `).run();

    store.commitThreadRefresh({
      threadId: "thread",
      observations: [{
        turnId: "turn",
        status: "completed",
        terminalKind: "completed",
        contentState: "ready",
        disposition: "monitoring",
        notification: { chatId: "new-chat", eventKind: "completed", text: "must not duplicate" },
      }],
      anchorTurnId: "turn",
      baselineState: "monitoring",
      monitoringStartedAt: 1_100,
      nextHistoryReconcileAt: 2_000,
      lastReconciledAt: 1_100,
    }, 1_100);

    expect(new DesktopMessageStore(state).listPendingNotifications(10_000)).toHaveLength(0);
    expect(store.getObservation("thread", "turn")?.disposition).toBe("already_known");
    state.close();
  });

  test("notification and anchor advance commit together with a stable terminal fingerprint", () => {
    const state = new StateDb(":memory:");
    const store = new CodexObserverStore(state, "/home");
    initialize(store);

    store.commitThreadRefresh({
      threadId: "thread",
      observations: [{
        turnId: "turn",
        status: "completed",
        terminalKind: "completed",
        contentState: "ready",
        disposition: "monitoring",
        notification: { chatId: "42", eventKind: "completed", text: "done" },
      }],
      anchorTurnId: "turn",
      baselineState: "monitoring",
      monitoringStartedAt: 1_100,
      nextHistoryReconcileAt: 2_000,
      lastReconciledAt: 1_100,
    }, 1_100);

    expect(store.getThreadState("thread")?.anchorTurnId).toBe("turn");
    const pending = new DesktopMessageStore(state).listPendingNotifications(10_000);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.eventFingerprint).toBe(terminalFingerprint("thread", "turn"));
    expect(store.getObservation("thread", "turn")?.disposition).toBe("notification_enqueued");
    state.close();
  });

  test("completed correction replaces only a pending interrupted outbox and uses a distinct identity", () => {
    const state = new StateDb(":memory:");
    const store = new CodexObserverStore(state, "/home");
    const messages = new DesktopMessageStore(state);
    initialize(store);

    store.commitThreadRefresh({
      threadId: "thread",
      observations: [{
        turnId: "turn",
        status: "interrupted",
        terminalKind: "interrupted",
        contentState: "confirmed_empty",
        disposition: "monitoring",
        notification: { chatId: "42", eventKind: "interrupted", text: "wrong interrupted" },
      }],
      anchorTurnId: "turn",
      baselineState: "monitoring",
      monitoringStartedAt: 1_100,
      nextHistoryReconcileAt: 2_000,
      lastReconciledAt: 1_100,
    }, 1_100);
    expect(messages.listPendingNotifications(10_000)).toMatchObject([{ eventKind: "interrupted" }]);
    expect(store.pendingTurnIds("thread")).toContain("turn");

    store.commitThreadRefresh({
      threadId: "thread",
      observations: [{
        turnId: "turn",
        status: "completed",
        terminalKind: "completed",
        contentState: "ready",
        disposition: "monitoring",
        replaceTerminalKind: true,
        notification: {
          chatId: "42",
          eventKind: "completed",
          text: "correct completed",
          correctionFromInterrupted: true,
        },
      }],
      anchorTurnId: "turn",
      baselineState: "monitoring",
      monitoringStartedAt: 1_100,
      nextHistoryReconcileAt: 2_000,
      lastReconciledAt: 1_200,
    }, 1_200);

    expect(messages.listPendingNotifications(10_000)).toMatchObject([{
      eventKind: "completed",
      eventFingerprint: terminalCorrectionFingerprint("thread", "turn"),
    }]);
    expect(store.terminalIdentityKinds("thread", "turn")).toEqual(new Set(["completed"]));
    expect(store.getObservation("thread", "turn")?.terminalKind).toBe("completed");
    expect(store.pendingTurnIds("thread")).not.toContain("turn");
    state.close();
  });

  test("CODEX_HOME mismatch fails closed without clearing existing observer state", () => {
    const state = new StateDb(":memory:");
    const original = new CodexObserverStore(state, "/home/a");
    initialize(original);
    original.registerCreatedThread("created", 2_000);

    const other = new CodexObserverStore(state, "/home/b");
    expect(other.ensureEnvironment(3_000)).toBe("reinitialize_required");
    expect(original.getThreadState("created")?.monitorFromAt).toBe(2_000);
    state.close();
  });

  test("bootstrap start is written once and survives catalog scan retries", () => {
    const state = new StateDb(":memory:");
    const store = new CodexObserverStore(state, "/home");
    store.ensureEnvironment(1_000);
    expect(store.beginBootstrap(2_000)).toBe(2_000);
    expect(store.beginBootstrap(9_000)).toBe(2_000);
    expect(store.getMeta()?.bootstrapStartedAt).toBe(2_000);
    state.close();
  });
});

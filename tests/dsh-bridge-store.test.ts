import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";

function tableRows(db: Database, table: string): Array<Record<string, unknown>> {
  return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
}

describe("DshBridgeStore", () => {
  test("dsh migration is additive and preserves populated Codex state", () => {
    const directory = mkdtempSync(join(tmpdir(), "sea-bridge-dsh-migration-"));
    const dbPath = join(directory, "state.sqlite3");
    let state = new StateDb(dbPath);
    state.db.query(
      "INSERT INTO desktop_message_links(telegram_chat_id,telegram_message_id,thread_id,turn_id,event_kind,event_fingerprint,sent_at) VALUES (?,?,?,?,?,?,?)",
    ).run("chat", 10, "thread", "turn", "completed", "codex-fp", 100);
    state.db.query(
      "INSERT INTO telegram_thread_deliveries(telegram_update_id,reply_to_message_id,thread_id,text_hash,status,created_at) VALUES (?,?,?,?,?,?)",
    ).run(11, 10, "thread", "hash", "received", 101);
    state.db.query(
      "INSERT INTO desktop_observer_cursors(thread_id,rollout_path,byte_offset,schema_fingerprint,last_event_fingerprint,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("thread", "/tmp/rollout", 12, "schema", "event", 102);
    state.db.query(
      "INSERT INTO desktop_notification_outbox(event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("outbox-fp", "chat", "thread", "turn", "completed", "text", "pending", 0, 103, 103, 103);
    state.db.query(
      "INSERT INTO user_preferences(telegram_chat_id,key,value,updated_at) VALUES (?,?,?,?)",
    ).run("chat", "default_model", "codex-model", 104);
    state.db.query(
      "INSERT INTO pending_new_thread_prompts(telegram_chat_id,prompt_message_id,project_id,project_name,cwd,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?)",
    ).run("chat", 20, "project", "Project", "/tmp/project", 105, 999, "pending");

    const codexTables = [
      "desktop_message_links",
      "telegram_thread_deliveries",
      "desktop_observer_cursors",
      "desktop_notification_outbox",
      "user_preferences",
      "pending_new_thread_prompts",
    ];
    const before = Object.fromEntries(codexTables.map((table) => [table, tableRows(state.db, table)]));

    for (const table of [
      "dsh_message_links",
      "dsh_deliveries",
      "dsh_observer_state",
      "dsh_notification_outbox",
      "dsh_callback_tokens",
      "dsh_creation_requests",
      "dsh_created_sessions",
      "dsh_pending_new_session_prompts",
    ]) {
      state.db.exec(`DROP TABLE ${table}`);
    }

    state.close();
    state = new StateDb(dbPath);

    for (const table of codexTables) {
      expect(tableRows(state.db, table)).toEqual(before[table]);
    }
    for (const table of [
      "dsh_message_links",
      "dsh_deliveries",
      "dsh_observer_state",
      "dsh_notification_outbox",
      "dsh_callback_tokens",
      "dsh_creation_requests",
      "dsh_created_sessions",
      "dsh_pending_new_session_prompts",
    ]) {
      expect(tableRows(state.db, table)).toEqual([]);
    }
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("claims one Telegram delivery exactly once and records a terminal result once", () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);

    expect(store.claimDelivery(101, 50, "session-a", "hash-a")).toBe("new");
    expect(store.claimDelivery(101, 50, "session-a", "hash-a")).toBe("duplicate");
    expect(store.markDeliveryDispatching(101)).toBe(true);
    expect(store.finishDelivery(101, "delivered")).toBe(true);
    expect(store.finishDelivery(101, "failed", "late_failure")).toBe(false);
    expect(store.getDelivery(101)).toEqual({
      updateId: 101,
      replyToMessageId: 50,
      sessionId: "session-a",
      textHash: "hash-a",
      status: "delivered",
      errorCode: null,
    });
    state.close();
  });

  test("enforces creation state transitions and preserves ambiguous dispatch", () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);

    expect(store.beginCreation(201, "project-a", null, "prompt-hash")).toBe("new");
    expect(store.beginCreation(201, "project-a", null, "prompt-hash")).toBe("duplicate");
    expect(store.transitionCreation(201, "received", "dispatching")).toBe(true);
    expect(store.transitionCreation(201, "dispatching", "accepted", {
      sessionId: "session-created",
      turnId: "turn-created",
    })).toBe(true);
    expect(store.transitionCreation(201, "accepted", "acknowledged")).toBe(true);
    expect(store.getCreation(201)).toEqual({
      updateId: 201,
      projectId: "project-a",
      modelId: null,
      promptHash: "prompt-hash",
      status: "acknowledged",
      sessionId: "session-created",
      turnId: "turn-created",
      errorCode: null,
    });

    expect(store.beginCreation(202, "project-a", "model-a", "prompt-hash-2")).toBe("new");
    expect(store.transitionCreation(202, "received", "dispatching")).toBe(true);
    expect(store.transitionCreation(202, "dispatching", "delivery_unknown", {
      errorCode: "transport_lost",
    })).toBe(true);
    expect(store.getCreation(202)?.status).toBe("delivery_unknown");

    expect(() => store.transitionCreation(201, "acknowledged", "dispatching")).toThrow("illegal dsh creation transition");
    expect(store.transitionCreation(202, "dispatching", "accepted")).toBe(false);
    state.close();
  });

  test("stores dsh model preference under an isolated namespace", () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);
    state.db.query(
      "INSERT INTO user_preferences(telegram_chat_id,key,value,updated_at) VALUES (?,?,?,?)",
    ).run("chat", "default_model", "codex-model", 1);

    expect(store.getDefaultModel("chat")).toBeNull();
    store.setDefaultModel("chat", "dsh-model");
    expect(store.getDefaultModel("chat")).toBe("dsh-model");
    expect(state.db.query(
      "SELECT value FROM user_preferences WHERE telegram_chat_id=? AND key='default_model'",
    ).get("chat")).toEqual({ value: "codex-model" });
    store.clearDefaultModel("chat");
    expect(store.getDefaultModel("chat")).toBeNull();
    state.close();
  });

  test("callback tokens are chat-bound, expiring, single-use, and stored only as hashes", () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);
    const now = 1_000;

    store.putCallback({
      token: "opaque-secret-token",
      chatId: "chat-a",
      action: "project.select",
      payload: { projectId: "project-a" },
      expiresAt: now + 100,
    }, now);

    const stored = state.db.query(
      "SELECT token_hash,payload_json FROM dsh_callback_tokens",
    ).get() as { token_hash: string; payload_json: string };
    expect(stored.token_hash).not.toContain("opaque-secret-token");
    expect(JSON.stringify(stored)).not.toContain("opaque-secret-token");

    expect(store.consumeCallback("opaque-secret-token", "chat-b", now + 1)).toBeNull();
    expect(store.consumeCallback("opaque-secret-token", "chat-a", now + 1)).toEqual({
      action: "project.select",
      payload: { projectId: "project-a" },
    });
    expect(store.consumeCallback("opaque-secret-token", "chat-a", now + 2)).toBeNull();

    store.putCallback({
      token: "expiring-token",
      chatId: "chat-a",
      action: "model.select",
      payload: { modelId: "model-a" },
      expiresAt: now + 10,
    }, now);
    expect(store.consumeCallback("expiring-token", "chat-a", now + 10)).toBeNull();
    expect(store.getCallbackStatus("expiring-token")).toBe("expired");
    state.close();
  });

  test("notification completion atomically creates the exact dsh reply mapping", () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);
    const now = 5_000;

    expect(store.enqueueNotification({
      eventFingerprint: "event-a",
      chatId: "chat-a",
      sessionId: "session-a",
      eventKind: "completed",
      text: "safe text",
    }, now)).toBe(true);
    expect(store.enqueueNotification({
      eventFingerprint: "event-a",
      chatId: "chat-a",
      sessionId: "session-a",
      eventKind: "completed",
      text: "safe text",
    }, now)).toBe(false);

    expect(store.completeNotification("event-a", 501, now + 1)).toBe(true);
    expect(store.findMessageLink("chat-a", 501)).toEqual({
      chatId: "chat-a",
      messageId: 501,
      sessionId: "session-a",
      eventKind: "completed",
      eventFingerprint: "event-a",
    });
    expect(store.listPendingNotifications(now + 1)).toEqual([]);

    store.linkMessage({
      chatId: "chat-a",
      messageId: 502,
      sessionId: "session-other",
      eventKind: "completed",
      eventFingerprint: "existing-link",
    }, now + 2);
    store.enqueueNotification({
      eventFingerprint: "event-conflict",
      chatId: "chat-a",
      sessionId: "session-a",
      eventKind: "completed",
      text: "safe text",
    }, now + 2);

    expect(() => store.completeNotification("event-conflict", 502, now + 3)).toThrow();
    expect(store.listPendingNotifications(now + 3).map((row) => row.eventFingerprint)).toContain("event-conflict");
    expect(store.findMessageLink("chat-a", 502)?.eventFingerprint).toBe("existing-link");
    state.close();
  });

  test("persists created-session marker and observer cursor independently", () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);

    expect(store.registerCreatedSession("session-created", 300, 1_000)).toBe(true);
    expect(store.registerCreatedSession("session-created", 300, 1_001)).toBe(false);
    expect(store.getCreatedSession("session-created")).toEqual({
      sessionId: "session-created",
      creationUpdateId: 300,
      baselinePending: true,
    });
    expect(store.consumeCreatedSessionBaseline("session-created")).toBe(true);
    expect(store.consumeCreatedSessionBaseline("session-created")).toBe(false);

    store.saveObserverState({
      sessionId: "session-created",
      cursor: 42,
      contractFingerprint: "dsh-0.1.7-rc.2/protocol-1",
      lastEventFingerprint: "event-42",
    }, 2_000);
    expect(store.getObserverState("session-created")).toEqual({
      sessionId: "session-created",
      cursor: 42,
      contractFingerprint: "dsh-0.1.7-rc.2/protocol-1",
      lastEventFingerprint: "event-42",
    });
    state.close();
  });

  test("pending new-session prompt is consumed once and expires safely", () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);
    const now = 10_000;

    store.createPendingNewSessionPrompt({
      chatId: "chat-a",
      promptMessageId: 700,
      projectId: "project-a",
      expiresAt: now + 100,
    }, now);
    expect(store.consumePendingNewSessionPrompt("chat-a", 700, now + 1)).toEqual({
      chatId: "chat-a",
      promptMessageId: 700,
      projectId: "project-a",
      expiresAt: now + 100,
    });
    expect(store.consumePendingNewSessionPrompt("chat-a", 700, now + 2)).toBeNull();

    store.createPendingNewSessionPrompt({
      chatId: "chat-a",
      promptMessageId: 701,
      projectId: "project-a",
      expiresAt: now + 5,
    }, now);
    expect(store.consumePendingNewSessionPrompt("chat-a", 701, now + 5)).toBeNull();
    expect(store.getPendingNewSessionPromptStatus("chat-a", 701)).toBe("expired");
    state.close();
  });
});

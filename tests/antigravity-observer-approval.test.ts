import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityDesktopObserver } from "../src/antigravity/desktop-observer.ts";
import { AntigravityDesktopReader } from "../src/antigravity/desktop-reader.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";
import { AntigravityTelegramStore } from "../src/antigravity/telegram-store.ts";
import type { InlineButton } from "../src/telegram/client.ts";

describe("AntigravityDesktopObserver & Web+Telegram shared approvals", () => {
  test("delivers managed session terminal notifications with reply button and links sea_bridge origin", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const tgStore = new AntigravityTelegramStore(db);
      const approvalBridge = new AntigravityApprovalBridge(store);

      const sentMessages: Array<{ chatId: string | number; text: string; buttons?: InlineButton[][] }> = [];
      let nextMsgId = 1000;

      const observer = new AntigravityDesktopObserver({
        store,
        tgStore,
        approvalBridge,
        telegram: {
          sendMessage: async (chatId, text, buttons) => {
            sentMessages.push({ chatId, text, ...(buttons ? { buttons } : {}) });
            return { message_id: ++nextMsgId };
          },
          editMessageReplyMarkup: async () => {},
        },
        chatId: "chat-1",
        replyEnabled: true,
        externalSessionsEnabled: false,
      });

      // Seed a completed managed session execution
      store.upsertSession({
        sessionId: "agy-sess-1",
        nativeSessionId: "agy-sess-1",
        projectId: "proj-1",
        cwd: "/opt/app/aitools/sea-bridge",
        title: "Refactor auth",
        modelId: "gemini-4-argon",
        reasoningEffort: "high",
        modeId: null,
        status: "idle",
        completeHistory: true,
        snapshotGeneration: 1,
        lastExecutionId: "exec-1",
        lastExecutionEpoch: 1,
        createdAt: 1_000,
        updatedAt: 2_000,
      });
      store.upsertExecution({
        executionId: "exec-1",
        operationId: "op-1",
        sessionId: "agy-sess-1",
        epoch: 1,
        processGeneration: 1,
        rpcRequestId: "1",
        status: "completed",
        stopReason: "end_turn",
        errorCode: null,
        createdAt: 1_000,
        updatedAt: 2_000,
      });
      store.upsertMessage({
        id: "msg-1",
        sessionId: "agy-sess-1",
        snapshotGeneration: 1,
        seq: 1,
        role: "assistant",
        kind: "message",
        text: "Auth refactoring is complete.",
        toolCallId: null,
        toolName: null,
        toolStatus: null,
        replayed: false,
        createdAt: 2_000,
      });

      await observer.pollOnce();

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.text).toContain("Antigravity (Sea-Bridge): Refactor auth");
      expect(sentMessages[0]!.text).toContain("Auth refactoring is complete.");
      expect(sentMessages[0]!.buttons?.[0]?.[0]?.text).toBe("💬 回复");
      expect(tgStore.findMessageLink("chat-1", 1001)?.sessionOrigin).toBe("sea_bridge");

      // Second poll does not duplicate notification for the same epoch
      await observer.pollOnce();
      expect(sentMessages).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("establishes baseline for existing Antigravity Desktop sessions without backfilling, then notifies on new turns without reply button", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-obs-desk-"));
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const tgStore = new AntigravityTelegramStore(db);
      const approvalBridge = new AntigravityApprovalBridge(store);

      const deskId = "11111111-2222-3333-4444-555555555555";
      const desktopDbPath = path.join(root, "conversation_summaries.db");
      const desktopDb = new Database(desktopDbPath, { create: true });
      desktopDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          step_count INTEGER NOT NULL DEFAULT 0,
          created_time TEXT NOT NULL DEFAULT '',
          last_modified_time TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'CASCADE_RUN_STATUS_IDLE',
          workspace_uris TEXT NOT NULL DEFAULT '[]',
          not_fully_idle INTEGER NOT NULL DEFAULT 0,
          nesting_depth INTEGER NOT NULL DEFAULT 0,
          parent_conversation_id TEXT NOT NULL DEFAULT '',
          killed INTEGER NOT NULL DEFAULT 0
        );
      `);
      desktopDb
        .query(
          `INSERT INTO conversation_summaries VALUES (?, 'Desktop Session', 'Preview', 2, '2026-11-09T01:00:00Z', '2026-11-09T01:01:00Z', 'CASCADE_RUN_STATUS_IDLE', ?, 0, 0, '', 0)`
        )
        .run(deskId, JSON.stringify(["file:///opt/app/aitools/sea-bridge"]));
      desktopDb.close();

      const logDir = path.join(root, "brain", deskId, ".system_generated", "logs");
      mkdirSync(logDir, { recursive: true });
      const transcriptPath = path.join(logDir, "transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "Old question" }),
          JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Old answer" }),
        ].join("\n") + "\n"
      );

      const desktopReader = new AntigravityDesktopReader({
        desktopAppDataDir: root,
        getAllowedProjects: () => [{ id: "sb", name: "sb", rootPath: "/opt/app/aitools/sea-bridge" }],
      });

      const sentMessages: Array<{ text: string; buttons?: InlineButton[][] }> = [];
      let nextMsgId = 2000;

      const observer = new AntigravityDesktopObserver({
        store,
        tgStore,
        approvalBridge,
        desktopReader,
        telegram: {
          sendMessage: async (_chatId, text, buttons) => {
            sentMessages.push({ text, ...(buttons ? { buttons } : {}) });
            return { message_id: ++nextMsgId };
          },
          editMessageReplyMarkup: async () => {},
        },
        chatId: "chat-1",
        replyEnabled: true,
        externalSessionsEnabled: false,
      });

      // First poll records baseline only (0 notifications sent)
      await observer.pollOnce();
      expect(sentMessages).toHaveLength(0);
      expect(tgStore.getObserverCursor("desktop", deskId)?.cursor).toBe(1);

      // Append a new completed turn to transcript.jsonl
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "Old question" }),
          JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Old answer" }),
          JSON.stringify({ step_index: 3, type: "USER_INPUT", content: "New question" }),
          JSON.stringify({ step_index: 4, type: "PLANNER_RESPONSE", content: "New desktop answer!" }),
        ].join("\n") + "\n"
      );

      await observer.pollOnce();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.text).toContain("Antigravity 桌面端（只读）: Desktop Session");
      expect(sentMessages[0]!.text).toContain("New desktop answer!");
      // Desktop read-only notification does NOT attach a reply button
      expect(sentMessages[0]!.buttons).toBeUndefined();
      expect(tgStore.findMessageLink("chat-1", 2001)?.sessionOrigin).toBe("desktop");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles 429 exponential backoff and quarantines ambiguous send failures", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const tgStore = new AntigravityTelegramStore(db);
      const approvalBridge = new AntigravityApprovalBridge(store);

      tgStore.enqueueNotification(
        {
          eventFingerprint: "fp-rate-1",
          chatId: "chat-1",
          sessionId: "sess-r",
          sessionOrigin: "sea_bridge",
          eventKind: "completed",
          text: "Rate limited msg",
        },
        1_000
      );
      tgStore.enqueueNotification(
        {
          eventFingerprint: "fp-ambig-2",
          chatId: "chat-1",
          sessionId: "sess-a",
          sessionOrigin: "sea_bridge",
          eventKind: "completed",
          text: "Ambiguous msg",
        },
        1_000
      );

      let call = 0;
      const observer = new AntigravityDesktopObserver({
        store,
        tgStore,
        approvalBridge,
        telegram: {
          sendMessage: async () => {
            call++;
            if (call === 1) {
              const err = new Error("Too Many Requests") as Error & { code: number };
              err.code = 429;
              throw err;
            }
            throw new Error("socket hang up");
          },
          editMessageReplyMarkup: async () => {},
        },
        chatId: "chat-1",
      });

      await observer.pollOnce();

      const row1 = db
        .query("SELECT status, attempt_count AS attemptCount, last_error AS lastError FROM antigravity_outbox WHERE event_fingerprint='fp-rate-1'")
        .get() as { status: string; attemptCount: number; lastError: string };
      expect(row1).toEqual({ status: "pending", attemptCount: 1, lastError: "telegram_rate_limited" });

      const row2 = db
        .query("SELECT status, last_error AS lastError FROM antigravity_outbox WHERE event_fingerprint='fp-ambig-2'")
        .get() as { status: string; lastError: string };
      expect(row2).toEqual({ status: "quarantined", lastError: "telegram_delivery_unknown" });
    } finally {
      db.close();
    }
  });

  test("shares pending approval between Web and Telegram, clearing Telegram buttons when decided from either side", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const tgStore = new AntigravityTelegramStore(db);
      const approvalBridge = new AntigravityApprovalBridge(store);

      const sentApprovals: Array<{ text: string; buttons?: InlineButton[][] }> = [];
      const clearedMarkups: Array<{ chatId: string | number; messageId: number }> = [];
      let nextMsgId = 3000;

      const observer = new AntigravityDesktopObserver({
        store,
        tgStore,
        approvalBridge,
        telegram: {
          sendMessage: async (_chatId, text, buttons) => {
            sentApprovals.push({ text, ...(buttons ? { buttons } : {}) });
            return { message_id: ++nextMsgId };
          },
          editMessageReplyMarkup: async (chatId, messageId) => {
            clearedMarkups.push({ chatId, messageId });
          },
        },
        chatId: "chat-1",
      });
      observer.start();

      // 1. Trigger a permission request -> Telegram receives inline buttons
      const { approval, promise } = approvalBridge.requestPermission({
        sessionId: "agy-sess-1",
        executionId: "exec-1",
        processGeneration: 1,
        rpcRequestId: "perm-1",
        request: {
          sessionId: "agy-sess-1",
          toolCall: { toolCallId: "tc-1", name: "run_command", title: "git status" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 15));
      expect(sentApprovals).toHaveLength(1);
      expect(sentApprovals[0]!.text).toContain("run_command");
      expect(sentApprovals[0]!.buttons?.[0]).toHaveLength(2);

      // 2. Decide on Web first -> resolves promise AND clears Telegram inline keyboard automatically
      const webDecision = approvalBridge.decide({
        sessionId: "agy-sess-1",
        approvalId: approval.id,
        optionId: "allow",
        decidedBy: "web:admin",
      });
      expect(webDecision.status).toBe("decided");
      expect(await promise).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

      await new Promise((r) => setTimeout(r, 15));
      expect(clearedMarkups).toEqual([{ chatId: "chat-1", messageId: 3001 }]);

      await observer.stop();
    } finally {
      db.close();
    }
  });
});

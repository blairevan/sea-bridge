import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";
import { AntigravityTelegramStore } from "../src/antigravity/telegram-store.ts";
import {
  createAntigravityCallback,
  formatAntigravityTerminal,
  renderAntigravityModelMenu,
  renderAntigravityProjectMenu,
} from "../src/antigravity/menu-ui.ts";

describe("AntigravityTelegramStore & menu-ui", () => {
  test("callback tokens are chat-bound, single-use, and expire by TTL", () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const tgStore = new AntigravityTelegramStore(db);

      const cbData = createAntigravityCallback(
        tgStore,
        "chat-1",
        "model.select",
        { modelId: "gemini-4-argon" },
        1_000,
        5_000
      );
      expect(cbData.startsWith("agy:")).toBe(true);
      const token = cbData.slice("agy:".length);

      // Wrong chat cannot consume
      expect(tgStore.consumeCallback(token, "chat-2", 2_000)).toBeNull();

      // Right chat consumes once
      expect(tgStore.consumeCallback(token, "chat-1", 2_000)).toEqual({
        action: "model.select",
        payload: { modelId: "gemini-4-argon" },
      });

      // Second consume fails
      expect(tgStore.consumeCallback(token, "chat-1", 2_500)).toBeNull();

      // Expired token cannot be consumed
      const expiredCb = createAntigravityCallback(tgStore, "chat-1", "reply", { sessionId: "s-1" }, 1_000, 1_000);
      expect(tgStore.consumeCallback(expiredCb.slice(4), "chat-1", 2_500)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("persists per-chat (modelId, reasoningEffort) preferences and ForceReply pending prompts", () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const tgStore = new AntigravityTelegramStore(db);

      expect(tgStore.getDefaultModel("chat-1")).toBeNull();
      tgStore.setDefaultModel("chat-1", { modelId: "gemini-4-argon", reasoningEffort: "high" }, 1_000);
      expect(tgStore.getDefaultModel("chat-1")).toEqual({
        modelId: "gemini-4-argon",
        reasoningEffort: "high",
      });
      tgStore.setDefaultModel("chat-1", null, 2_000);
      expect(tgStore.getDefaultModel("chat-1")).toBeNull();

      // Pending prompt lifecycle
      tgStore.createPendingNewSessionPrompt(
        {
          chatId: "chat-1",
          promptMessageId: 101,
          projectId: "proj-1",
          projectName: "SeaBridge",
          expiresAt: 10_000,
        },
        1_000
      );
      expect(tgStore.getPendingNewSessionPromptStatus("chat-1", 101, 2_000)).toBe("pending");
      const consumed = tgStore.consumePendingNewSessionPrompt("chat-1", 101, 2_000);
      expect(consumed).toEqual({
        chatId: "chat-1",
        promptMessageId: 101,
        projectId: "proj-1",
        projectName: "SeaBridge",
        expiresAt: 10_000,
      });
      expect(tgStore.getPendingNewSessionPromptStatus("chat-1", 101, 2_500)).toBe("consumed");
      expect(tgStore.consumePendingNewSessionPrompt("chat-1", 101, 2_500)).toBeNull();

      // Expired prompt
      tgStore.createPendingNewSessionPrompt(
        {
          chatId: "chat-1",
          promptMessageId: 102,
          projectId: "proj-1",
          projectName: "SeaBridge",
          expiresAt: 5_000,
        },
        1_000
      );
      expect(tgStore.consumePendingNewSessionPrompt("chat-1", 102, 6_000)).toBeNull();
      expect(tgStore.getPendingNewSessionPromptStatus("chat-1", 102, 6_000)).toBe("expired");
    } finally {
      db.close();
    }
  });

  test("enforces creation & delivery state machines and recovers interrupted dispatching writes on startup", () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const tgStore = new AntigravityTelegramStore(db);

      expect(tgStore.beginCreation(501, "proj-1", "gemini-4-argon", "high", "hash-1", 1_000)).toBe("new");
      expect(tgStore.beginCreation(501, "proj-1", "gemini-4-argon", "high", "hash-1", 1_100)).toBe("duplicate");
      expect(tgStore.transitionCreation(501, "received", "dispatching", {}, 1_200)).toBe(true);
      expect(
        tgStore.transitionCreation(501, "dispatching", "accepted", { sessionId: "sess-1", turnId: "exec-1" }, 1_300)
      ).toBe(true);
      expect(tgStore.acknowledgeCreation(501, "chat-1", 9001, "sess-1", "fp-created-1", 1_400)).toBe(true);
      expect(tgStore.findMessageLink("chat-1", 9001)?.sessionOrigin).toBe("sea_bridge");

      // Interrupted creation + delivery recovery
      expect(tgStore.beginCreation(502, "proj-1", null, null, "hash-2", 2_000)).toBe("new");
      expect(tgStore.transitionCreation(502, "received", "dispatching", {}, 2_100)).toBe(true);

      expect(tgStore.claimDelivery(601, 9001, "sess-1", "dhash-1", 2_000)).toBe("new");
      expect(tgStore.markDeliveryDispatching(601, 2_100)).toBe(true);

      const recovered = tgStore.recoverInterruptedWrites(3_000);
      expect(recovered).toEqual({ creations: 1, deliveries: 1 });
      expect(tgStore.getCreation(502)?.status).toBe("delivery_unknown");
      expect(tgStore.getDelivery(601)?.status).toBe("delivery_unknown");
    } finally {
      db.close();
    }
  });

  test("manages outbox notifications, message links, and cross-provider findLatestReplyMessageId", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE desktop_message_links (
          telegram_chat_id TEXT NOT NULL,
          telegram_message_id INTEGER NOT NULL
        );
        CREATE TABLE dsh_message_links (
          telegram_chat_id TEXT NOT NULL,
          telegram_message_id INTEGER NOT NULL
        );
      `);
      migrateAntigravityBridgeTables(db);
      const tgStore = new AntigravityTelegramStore(db);

      db.query("INSERT INTO desktop_message_links VALUES ('chat-1', 10)").run();
      db.query("INSERT INTO dsh_message_links VALUES ('chat-1', 25)").run();

      tgStore.enqueueNotification(
        {
          eventFingerprint: "fp-out-1",
          chatId: "chat-1",
          sessionId: "desk-sess-1",
          sessionOrigin: "desktop",
          eventKind: "completed",
          text: "Antigravity 桌面端（只读）: 通知",
        },
        1_000
      );

      const pending = tgStore.listPendingNotifications(1_000);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.sessionOrigin).toBe("desktop");

      // Complete notification atomically links message with session_origin='desktop'
      expect(tgStore.completeNotification("fp-out-1", 40, "desktop", 1_500)).toBe(true);
      expect(tgStore.findMessageLink("chat-1", 40)).toEqual({
        chatId: "chat-1",
        messageId: 40,
        sessionId: "desk-sess-1",
        sessionOrigin: "desktop",
        eventKind: "completed",
        eventFingerprint: "fp-out-1",
      });
      expect(tgStore.findLatestReplyMessageId("chat-1")).toBe(40);
    } finally {
      db.close();
    }
  });

  test("renders model + reasoningEffort menu and formats redacted terminal chunks", () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const tgStore = new AntigravityTelegramStore(db);

      const projectsMenu = renderAntigravityProjectMenu(
        [{ id: "sea-bridge", name: "SeaBridge", rootPath: "/opt/app/aitools/sea-bridge", policyVersion: "v1", updatedAt: 1 }],
        0,
        "chat-1",
        tgStore,
        1_000
      );
      expect(projectsMenu.text).toContain("选择 Antigravity 项目");
      expect(projectsMenu.buttons).toHaveLength(1);

      const models = [
        {
          id: "gemini-4-argon",
          name: "Gemini 4 Argon",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
        {
          id: "gpt-oss-120b-medium",
          name: "GPT-OSS 120B (Medium)",
        },
      ];

      // Multi-effort model menu includes effort row
      const multiMenu = renderAntigravityModelMenu(
        models,
        { modelId: "gemini-4-argon", reasoningEffort: "high" },
        0,
        "chat-1",
        tgStore,
        1_000
      );
      expect(multiMenu.text).toContain("Gemini 4 Argon");
      expect(multiMenu.text).toContain("思考等级：high");
      const allButtonTexts = multiMenu.buttons.flat().map((b) => b.text);
      expect(allButtonTexts).toContain("✓ Gemini 4 Argon");
      expect(allButtonTexts).toContain("思考等级: low");
      expect(allButtonTexts).toContain("思考等级: medium");
      expect(allButtonTexts).toContain("✓ 思考等级: high");

      // Single-tier model menu marks effort fixed
      const singleMenu = renderAntigravityModelMenu(
        models,
        { modelId: "gpt-oss-120b-medium", reasoningEffort: null },
        0,
        "chat-1",
        tgStore,
        1_000
      );
      expect(singleMenu.text).toContain("思考等级：固定（不可调）");
      expect(singleMenu.buttons.flat().some((b) => b.text.includes("思考等级:"))).toBe(false);

      // Terminal formatter splits long answers and redacts secrets
      const longAnswer = "A".repeat(3_500) + "\n" + "B".repeat(500);
      const formatted = formatAntigravityTerminal("completed", "My Session", longAnswer, "sea_bridge");
      expect(formatted.parts.length).toBe(2);
      expect(formatted.parts[0]).toContain("Antigravity (Sea-Bridge): My Session");
      expect(formatted.parts[0]).toContain("状态: 执行完成");
    } finally {
      db.close();
    }
  });
});

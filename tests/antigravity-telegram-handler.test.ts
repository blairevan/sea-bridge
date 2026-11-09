import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import { loadAntigravityConfig } from "../src/antigravity/config.ts";
import { AntigravityDesktopObserver } from "../src/antigravity/desktop-observer.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravityNewSessionManager } from "../src/antigravity/new-session-manager.ts";
import { AntigravityReplyRouter } from "../src/antigravity/reply-router.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";
import { AntigravityTelegramHandler } from "../src/antigravity/telegram-handler.ts";
import { AntigravityTelegramStore } from "../src/antigravity/telegram-store.ts";
import type { InlineButton } from "../src/telegram/client.ts";

const modelsFixture = readFileSync(
  path.join(import.meta.dir, "fixtures", "antigravity-acp", "agy-models.txt"),
  "utf8"
);

describe("AntigravityTelegramHandler end-to-end commands & callbacks", () => {
  test("handles /agy_status, /agy_projects, /agy_model (model + effort switching), /agy_new (menu + ForceReply + direct), and approval callbacks", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const tgStore = new AntigravityTelegramStore(db);
      store.upsertProject({
        id: "sea-bridge",
        name: "SeaBridge",
        rootPath: "/opt/app/aitools/sea-bridge",
        policyVersion: "v1",
        updatedAt: 1_000,
      });

      const config = loadAntigravityConfig({
        SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
        SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED: "true",
      });
      const capabilityGate = new AntigravityCapabilityGate({
        enabled: true,
        writeEnabled: true,
        desktopReadEnabled: true,
      });
      const modelCatalog = new AntigravityModelCatalog({
        cliPath: "/bin/echo",
        runner: async () => modelsFixture,
      });
      const approvalBridge = new AntigravityApprovalBridge(store);

      const sentMessages: Array<{
        messageId: number;
        chatId: string | number;
        text: string;
        buttons?: InlineButton[][];
        forceReply?: boolean;
      }> = [];
      const editedMessages: Array<{ messageId: number; text: string; buttons?: InlineButton[][] }> = [];
      const callbackAnswers: Array<{ id: string; text?: string }> = [];
      let nextMsgId = 100;

      const telegramClient = {
        sendMessage: async (chatId: string | number, text: string, buttons?: InlineButton[][], forceReply?: boolean) => {
          const messageId = ++nextMsgId;
          sentMessages.push({
            messageId,
            chatId,
            text,
            ...(buttons ? { buttons } : {}),
            ...(forceReply ? { forceReply } : {}),
          });
          return { message_id: messageId };
        },
        sendForceReply: async (chatId: string | number, text: string) => {
          const messageId = ++nextMsgId;
          sentMessages.push({ messageId, chatId, text, forceReply: true });
          return { message_id: messageId };
        },
        editMessageText: async (_chatId: string | number, messageId: number, text: string, buttons?: InlineButton[][]) => {
          editedMessages.push({ messageId, text, ...(buttons ? { buttons } : {}) });
        },
        editMessageReplyMarkup: async () => {},
        answerCallbackQuery: async (id: string, text?: string) => {
          callbackAnswers.push({ id, ...(text ? { text } : {}) });
        },
      };

      const fakeSessionManager = {
        create: async (req: { projectId: string; prompt: string; modelId?: string | null; reasoningEffort?: string | null }) => ({
          state: "queued" as const,
          sessionId: "agy-sess-555",
          turnId: "exec-555",
        }),
        send: async () => ({
          state: "queued" as const,
          sessionId: "agy-sess-555",
        }),
      };

      const newSessions = new AntigravityNewSessionManager({
        store,
        tgStore,
        modelCatalog,
        sessionManager: fakeSessionManager,
      });
      const replyRouter = new AntigravityReplyRouter({
        tgStore,
        externalSessionsEnabled: false,
        sessionManager: fakeSessionManager,
      });
      const observer = new AntigravityDesktopObserver({
        store,
        tgStore,
        approvalBridge,
        telegram: telegramClient,
        chatId: "999",
        replyEnabled: true,
      });

      const handler = new AntigravityTelegramHandler({
        config,
        store,
        tgStore,
        capabilityGate,
        modelCatalog,
        approvalBridge,
        newSessions,
        replyRouter,
        observer,
        telegram: telegramClient,
      });

      expect(handler.getBotCommands().map((c) => c.command)).toEqual([
        "agy_status",
        "agy_projects",
        "agy_model",
        "agy_new",
      ]);

      // 1. /agy_status
      expect(await handler.tryHandleCommand(1, 999, 10, "/agy_status")).toBe(true);
      expect(sentMessages.at(-1)?.text).toContain("Antigravity ACP：已启用（完整托管模式）");

      // 2. /agy_projects
      expect(await handler.tryHandleCommand(2, 999, 11, "/agy_projects")).toBe(true);
      expect(sentMessages.at(-1)?.text).toContain("[1] SeaBridge");
      expect(sentMessages.at(-1)?.text).toContain("/agy_new <序号> <需求>");

      // 3. /agy_model -> select Claude Opus 5.5 -> switch effort to high
      expect(await handler.tryHandleCommand(3, 999, 12, "/agy_model")).toBe(true);
      const modelMenuMsg = sentMessages.at(-1)!;
      const claudeBtn = modelMenuMsg.buttons?.flat().find((b) => b.text.includes("Claude Opus 5.5"));
      expect(claudeBtn).toBeDefined();

      expect(await handler.tryHandleCallback(4, 999, "cb-1", modelMenuMsg.messageId, claudeBtn!.callback_data)).toBe(true);
      expect(tgStore.getDefaultModel("999")).toEqual({
        modelId: "claude-opus-5-5",
        reasoningEffort: "low",
      });
      const refreshedMenu = editedMessages.at(-1)!;
      const highEffortBtn = refreshedMenu.buttons?.flat().find((b) => b.text === "思考等级: high");
      expect(highEffortBtn).toBeDefined();

      expect(await handler.tryHandleCallback(5, 999, "cb-2", modelMenuMsg.messageId, highEffortBtn!.callback_data)).toBe(true);
      expect(tgStore.getDefaultModel("999")).toEqual({
        modelId: "claude-opus-5-5",
        reasoningEffort: "high",
      });

      // 4. /agy_new (menu -> project select -> ForceReply -> create)
      expect(await handler.tryHandleCommand(6, 999, 15, "/agy_new")).toBe(true);
      const projMenuMsg = sentMessages.at(-1)!;
      const projBtn = projMenuMsg.buttons?.[0]?.[0];
      expect(projBtn?.text).toBe("SeaBridge");

      expect(await handler.tryHandleCallback(7, 999, "cb-3", projMenuMsg.messageId, projBtn!.callback_data)).toBe(true);
      const forceReplyMsg = sentMessages.at(-1)!;
      expect(forceReplyMsg.forceReply).toBe(true);
      expect(handler.getPendingPromptStatus("999", forceReplyMsg.messageId)).toBe("pending");

      await handler.handlePendingPromptReply(8, 999, forceReplyMsg.messageId, "Build Telegram handler");
      const ackMsg = sentMessages.at(-1)!;
      expect(ackMsg.text).toContain("🚀 已创建 Antigravity 会话并接收第一轮需求");
      expect(ackMsg.text).toContain("模型: Claude Opus 5.5 (high)");
      expect(ackMsg.buttons?.[0]?.[0]?.text).toBe("💬 回复");

      // 5. Approval callback via Telegram button
      observer.start();
      const { approval, promise } = approvalBridge.requestPermission({
        sessionId: "agy-sess-555",
        executionId: "exec-555",
        processGeneration: 1,
        rpcRequestId: "perm-9",
        request: {
          sessionId: "agy-sess-555",
          toolCall: { toolCallId: "tc-9", name: "run_command", title: "bun test" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });
      await new Promise((r) => setTimeout(r, 15));
      const approvalMsg = sentMessages.at(-1)!;
      const allowBtn = approvalMsg.buttons?.[0]?.[0];
      expect(allowBtn).toBeDefined();

      expect(await handler.tryHandleCallback(9, 999, "cb-ap", approvalMsg.messageId, allowBtn!.callback_data)).toBe(true);
      expect(await promise).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(store.getApproval(approval.id)?.decidedBy).toBe("telegram:999");

      await observer.stop();
    } finally {
      db.close();
    }
  });
});

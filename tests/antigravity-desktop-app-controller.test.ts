import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateDb } from "../src/state/db.ts";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import { AntigravityDesktopAppController } from "../src/antigravity/desktop-app-controller.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravityNewSessionManager } from "../src/antigravity/new-session-manager.ts";
import { AntigravityReplyRouter } from "../src/antigravity/reply-router.ts";
import { AntigravityStore } from "../src/antigravity/store.ts";
import { AntigravityTelegramHandler, type TelegramHandlerClient } from "../src/antigravity/telegram-handler.ts";
import { AntigravityTelegramStore } from "../src/antigravity/telegram-store.ts";

function createFakeTelegram() {
  const sent: Array<{ chatId: string; text: string; buttons?: Array<Array<{ text: string; callback_data: string }>> }> = [];
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextId = 500;
  const client: TelegramHandlerClient = {
    async sendMessage(chatId, text, buttons) {
      const id = nextId++;
      sent.push({ chatId: String(chatId), text, ...(buttons ? { buttons } : {}) });
      return { message_id: id };
    },
    async sendForceReply(chatId, text) {
      const id = nextId++;
      sent.push({ chatId: String(chatId), text });
      return { message_id: id };
    },
    async editMessageText(chatId, messageId, text) {
      edited.push({ chatId: String(chatId), messageId, text });
      return {};
    },
    async editMessageReplyMarkup() {
      return {};
    },
    async answerCallbackQuery() {
      return {};
    },
  };
  return { client, sent, edited };
}

describe("AntigravityDesktopAppController", () => {
  test("prompts when desktop session is open in Antigravity.app, quits before send, and reopens on turn settle", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sea-bridge-agy-desktop-ctrl-"));
    try {
      const stateDb = new StateDb(path.join(tmpDir, "state.db"));
      const store = new AntigravityStore(stateDb.db);
      const tgStore = new AntigravityTelegramStore(stateDb.db);
      const tg = createFakeTelegram();

      const sessionId = "dcb877b7-5ce5-4c80-b5f9-a1d3b198a404";
      mkdirSync(path.join(tmpDir, "presence"), { recursive: true });
      writeFileSync(path.join(tmpDir, "presence", `${sessionId}.lock`), "");

      let desktopAppOpen = true;
      const executedCommands: Array<{ cmd: string; args: string[] }> = [];

      const controller = new AntigravityDesktopAppController({
        desktopAppDataDir: tmpDir,
        tgStore,
        telegram: tg.client,
        sleepFn: async () => {},
        runCommand: async (cmd, args) => {
          executedCommands.push({ cmd, args });
          if (cmd === "lsof") {
            return desktopAppOpen
              ? { exitCode: 0, stdout: "5921\n", stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "" };
          }
          if (cmd === "ps") {
            return {
              exitCode: 0,
              stdout: "/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone\n",
              stderr: "",
            };
          }
          if (cmd === "osascript") {
            desktopAppOpen = false;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (cmd === "open") {
            desktopAppOpen = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      tgStore.linkMessage({
        chatId: "1001",
        messageId: 77,
        sessionId,
        sessionOrigin: "desktop",
        eventKind: "turn_completed",
        eventFingerprint: "fp-desktop-77",
      });

      const sentPrompts: string[] = [];
      const replyRouter = new AntigravityReplyRouter({
        tgStore,
        externalSessionsEnabled: true,
        desktopAppController: controller,
        sessionManager: {
          async send(_id, _opId, prompt) {
            sentPrompts.push(prompt);
            return { state: "queued", sessionId, turnId: "turn-1" };
          },
        },
      });

      const handler = new AntigravityTelegramHandler({
        config: {
          enabled: true,
          writeEnabled: true,
          desktopReadEnabled: true,
          externalSessionsEnabled: true,
          approvalPolicy: "auto",
          maxActive: 8,
          cliPath: "agy",
          geminiDir: tmpDir,
          appDataDir: "antigravity-cli",
          desktopAppDataDir: tmpDir,
          approvalTimeoutMs: 60_000,
          allowedProjects: [],
        },
        store,
        tgStore,
        capabilityGate: new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true }),
        modelCatalog: new AntigravityModelCatalog({ cliPath: "agy" }),
        approvalBridge: new AntigravityApprovalBridge(store),
        newSessions: new AntigravityNewSessionManager({
          store,
          tgStore,
          modelCatalog: new AntigravityModelCatalog({ cliPath: "agy" }),
          sessionManager: { async create() { return { state: "failed", sessionId: null }; } } as never,
        }),
        replyRouter,
        desktopAppController: controller,
        telegram: tg.client,
      });

      // Step 1: Reply while Antigravity.app holds the lock -> prompts instead of sending immediately
      const firstAttempt = await replyRouter.deliver(8001, "1001", 77, "你好桌面端");
      expect(firstAttempt).toEqual({ status: "desktop_app_open", sessionId });
      expect(sentPrompts).toEqual([]);
      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0]!.text).toContain("已在 Antigravity 桌面端打开");
      const restartBtn = tg.sent[0]!.buttons?.[0]?.[0];
      expect(restartBtn?.text).toContain("关闭桌面端");

      // Step 2: Click the "restart" inline button -> quits Antigravity.app, delivers prompt
      await handler.tryHandleCallback(8002, 1001, "cb-1", 500, restartBtn!.callback_data);
      expect(sentPrompts).toEqual(["你好桌面端"]);
      expect(executedCommands.some((c) => c.cmd === "osascript")).toBe(true);
      expect(executedCommands.some((c) => c.cmd === "open")).toBe(false);

      // Step 3: Turn finishes and settles -> automatically reopens Antigravity.app
      await controller.onDesktopTurnSettled(sessionId);
      expect(executedCommands.some((c) => c.cmd === "open")).toBe(true);
      expect(desktopAppOpen).toBe(true);

      stateDb.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

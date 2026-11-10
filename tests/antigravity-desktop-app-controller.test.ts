import { Database } from "bun:sqlite";
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
  test("delivers immediately while keeping Antigravity.app open, then auto-restarts on turn settle when idle", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sea-bridge-agy-desktop-ctrl-"));
    try {
      const stateDb = new StateDb(path.join(tmpDir, "state.db"));
      const tgStore = new AntigravityTelegramStore(stateDb.db);
      const tg = createFakeTelegram();

      const sessionId = "dcb877b7-5ce5-4c80-b5f9-a1d3b198a404";
      const nativeProjectId = "43e4063c-f55e-4006-90df-7f7aea9ee9ad";
      mkdirSync(path.join(tmpDir, "presence"), { recursive: true });
      writeFileSync(path.join(tmpDir, "presence", `${sessionId}.lock`), "");

      const summariesDb = new Database(path.join(tmpDir, "conversation_summaries.db"));
      summariesDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT);");
      summariesDb
        .prepare("INSERT INTO conversation_summaries (conversation_id, project_id) VALUES (?, ?)")
        .run(sessionId, nativeProjectId);
      summariesDb.close();

      let desktopAppOpen = true;
      const executedCommands: Array<{ cmd: string; args: string[] }> = [];

      const controller = new AntigravityDesktopAppController({
        desktopAppDataDir: tmpDir,
        desktopReader: {
          listSessions: () => [],
        },
        tgStore,
        telegram: tg.client,
        sleepFn: async () => {},
        runCommand: async (cmd, args) => {
          executedCommands.push({ cmd, args });
          if (cmd === "lsof") {
            // Simulate macOS lsof exitCode=1 when .lock was released by agy acp but .db is still held by Antigravity.app
            return desktopAppOpen
              ? { exitCode: 1, stdout: "5921\n", stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "" };
          }
          if (cmd === "pgrep") {
            return desktopAppOpen
              ? { exitCode: 0, stdout: "5894\n", stderr: "" }
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

      // Step 1: Reply delivers immediately WITHOUT closing Antigravity.app during execution
      const res = await replyRouter.deliver(8001, "1001", 77, "长任务执行测试");
      expect(res).toEqual({ status: "delivered", sessionId });
      expect(sentPrompts).toEqual(["长任务执行测试"]);
      expect(executedCommands.some((c) => c.cmd === "osascript")).toBe(false);
      expect(desktopAppOpen).toBe(true);

      // Step 2: Turn finishes -> automatically performs fast quit + open restart with project deep link
      await controller.onDesktopTurnSettled(sessionId);
      expect(executedCommands.some((c) => c.cmd === "osascript")).toBe(true);
      const openCmd = executedCommands.find((c) => c.cmd === "open");
      expect(openCmd).toBeDefined();
      expect(openCmd?.args).toContain(`antigravity://open?project=${nativeProjectId}`);
      expect(desktopAppOpen).toBe(true);

      stateDb.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("defers restart and sends inline button when another desktop session is actively running", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sea-bridge-agy-desktop-defer-"));
    try {
      const stateDb = new StateDb(path.join(tmpDir, "state.db"));
      const store = new AntigravityStore(stateDb.db);
      const tgStore = new AntigravityTelegramStore(stateDb.db);
      const tg = createFakeTelegram();

      const sessionId = "dcb877b7-5ce5-4c80-b5f9-a1d3b198a404";
      const nativeProjectId = "43e4063c-f55e-4006-90df-7f7aea9ee9ad";
      mkdirSync(path.join(tmpDir, "presence"), { recursive: true });
      writeFileSync(path.join(tmpDir, "presence", `${sessionId}.lock`), "");

      const summariesDb = new Database(path.join(tmpDir, "conversation_summaries.db"));
      summariesDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT);");
      summariesDb
        .prepare("INSERT INTO conversation_summaries (conversation_id, project_id) VALUES (?, ?)")
        .run(sessionId, nativeProjectId);
      summariesDb.close();

      let desktopAppOpen = true;
      const executedCommands: Array<{ cmd: string; args: string[] }> = [];

      const controller = new AntigravityDesktopAppController({
        desktopAppDataDir: tmpDir,
        desktopReader: {
          listSessions: () => [
            {
              source: "antigravity" as never,
              id: "11111111-2222-4333-8444-555555555555",
              title: "Other active task",
              updatedAt: Date.now(),
              projectId: "proj-1",
              creationClient: { kind: "desktop", evidence: "explicit" },
              state: "running",
              sendEnabled: false,
            },
          ],
        },
        tgStore,
        telegram: tg.client,
        sleepFn: async () => {},
        runCommand: async (cmd, args) => {
          executedCommands.push({ cmd, args });
          if (cmd === "lsof") {
            // Simulate macOS lsof exitCode=1 when .lock was released by agy acp but .db is still held by Antigravity.app
            return desktopAppOpen
              ? { exitCode: 1, stdout: "5921\n", stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "" };
          }
          if (cmd === "pgrep") {
            return desktopAppOpen
              ? { exitCode: 0, stdout: "5894\n", stderr: "" }
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

      const replyRouter = new AntigravityReplyRouter({
        tgStore,
        externalSessionsEnabled: true,
        desktopAppController: controller,
        sessionManager: {
          async send() {
            return { state: "queued", sessionId, turnId: "turn-2" };
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

      controller.markRefreshAfterTurn(sessionId, "1001");
      await controller.onDesktopTurnSettled(sessionId);

      // Should NOT have quit Antigravity.app while another session is running
      expect(executedCommands.some((c) => c.cmd === "osascript")).toBe(false);
      expect(tg.sent.length).toBe(1);
      expect(tg.sent[0]!.text).toContain("有其他会话正在执行任务");
      const refreshBtn = tg.sent[0]!.buttons?.[0]?.[0];
      expect(refreshBtn?.text).toContain("立即重启桌面端同步显示");

      // Clicking the button triggers restart on demand
      await handler.tryHandleCallback(9002, 1001, "cb-refresh", 500, refreshBtn!.callback_data);
      expect(executedCommands.some((c) => c.cmd === "osascript")).toBe(true);
      expect(executedCommands.some((c) => c.cmd === "open")).toBe(true);

      stateDb.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("refreshes Antigravity.app when a desktop session turn settles from Web without explicit markRefreshAfterTurn", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sea-bridge-agy-desktop-web-"));
    try {
      const stateDb = new StateDb(path.join(tmpDir, "state.db"));
      const tgStore = new AntigravityTelegramStore(stateDb.db);
      const tg = createFakeTelegram();

      const sessionId = "dcb877b7-5ce5-4c80-b5f9-a1d3b198a404";
      const nativeProjectId = "43e4063c-f55e-4006-90df-7f7aea9ee9ad";
      mkdirSync(path.join(tmpDir, "presence"), { recursive: true });
      writeFileSync(path.join(tmpDir, "presence", `${sessionId}.lock`), "");

      const summariesDb = new Database(path.join(tmpDir, "conversation_summaries.db"));
      summariesDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, project_id TEXT);");
      summariesDb
        .prepare("INSERT INTO conversation_summaries (conversation_id, project_id) VALUES (?, ?)")
        .run(sessionId, nativeProjectId);
      summariesDb.close();

      let desktopAppOpen = true;
      const executedCommands: Array<{ cmd: string; args: string[] }> = [];

      const controller = new AntigravityDesktopAppController({
        desktopAppDataDir: tmpDir,
        desktopReader: { listSessions: () => [] },
        tgStore,
        telegram: tg.client,
        defaultChatId: "1001",
        sleepFn: async () => {},
        runCommand: async (cmd, args) => {
          executedCommands.push({ cmd, args });
          if (cmd === "lsof") {
            return desktopAppOpen ? { exitCode: 1, stdout: "5921\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
          }
          if (cmd === "pgrep") {
            return desktopAppOpen ? { exitCode: 0, stdout: "5894\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
          }
          if (cmd === "ps") {
            return { exitCode: 0, stdout: "/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone\n", stderr: "" };
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

      await controller.onDesktopTurnSettled(sessionId);
      expect(executedCommands.some((c) => c.cmd === "osascript")).toBe(true);
      const openCmd = executedCommands.find((c) => c.cmd === "open");
      expect(openCmd?.args).toContain(`antigravity://open?project=${nativeProjectId}`);

      stateDb.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

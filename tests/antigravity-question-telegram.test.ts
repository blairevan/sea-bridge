import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InlineButton } from "../src/telegram/client.ts";
import { StateDb } from "../src/state/db.ts";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import { loadAntigravityConfig } from "../src/antigravity/config.ts";
import { AntigravityDesktopObserver } from "../src/antigravity/desktop-observer.ts";
import { AntigravityDesktopReader } from "../src/antigravity/desktop-reader.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravityNewSessionManager } from "../src/antigravity/new-session-manager.ts";
import { AntigravityReplyRouter } from "../src/antigravity/reply-router.ts";
import { AntigravityStore } from "../src/antigravity/store.ts";
import { AntigravityTelegramHandler, type TelegramHandlerClient } from "../src/antigravity/telegram-handler.ts";
import { AntigravityTelegramStore } from "../src/antigravity/telegram-store.ts";
import type { SourceResult, SourceSendOptions } from "../src/web/sources/types.ts";

const tempDirs: string[] = [];

function createTempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sea-agy-tg-q-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeTelegram() {
  let nextMsgId = 100;
  const sent: Array<{ messageId: number; chatId: string; text: string; buttons?: InlineButton[][] }> = [];
  const editedText: Array<{ chatId: string; messageId: number; text: string; buttons?: InlineButton[][] }> = [];
  const editedMarkup: Array<{ chatId: string; messageId: number; buttons?: InlineButton[][] }> = [];
  const answered: Array<{ callbackId: string; text?: string }> = [];

  const client: TelegramHandlerClient = {
    async sendMessage(chatId, text, buttons) {
      const messageId = nextMsgId++;
      sent.push({ messageId, chatId: String(chatId), text, ...(buttons ? { buttons } : {}) });
      return { message_id: messageId };
    },
    async sendForceReply(chatId, text) {
      const messageId = nextMsgId++;
      sent.push({ messageId, chatId: String(chatId), text });
      return { message_id: messageId };
    },
    async editMessageText(chatId, messageId, text, buttons) {
      editedText.push({ chatId: String(chatId), messageId, text, ...(buttons ? { buttons } : {}) });
      return {};
    },
    async editMessageReplyMarkup(chatId, messageId, buttons) {
      editedMarkup.push({ chatId: String(chatId), messageId, ...(buttons ? { buttons } : {}) });
      return {};
    },
    async answerCallbackQuery(callbackId, text) {
      answered.push({ callbackId, ...(text !== undefined ? { text } : {}) });
      return {};
    },
  };

  return { client, sent, editedText, editedMarkup, answered };
}

function writeDesktopState(params: {
  desktopDir: string;
  sessionId: string;
  projectDir: string;
  title: string;
  status: "CASCADE_RUN_STATUS_RUNNING" | "CASCADE_RUN_STATUS_IDLE";
  steps: unknown[];
}): void {
  mkdirSync(params.desktopDir, { recursive: true });
  const db = new Database(path.join(params.desktopDir, "conversation_summaries.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      killed INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(`
    INSERT OR REPLACE INTO conversation_summaries(
      conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
    ) VALUES (?, ?, '', ?, '2026-11-11T12:00:00Z', ?, ?, ?)
  `).run(
    params.sessionId,
    params.title,
    params.steps.length,
    JSON.stringify([`file://${params.projectDir}`]),
    params.status,
    params.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0,
  );
  db.close();

  const logDir = path.join(params.desktopDir, "brain", params.sessionId, ".system_generated", "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, "transcript.jsonl"), params.steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

describe("Telegram ask_question notifications, paginated wizard & shorthand replies (2A)", () => {
  test("delivers single-question 1-click option buttons in real time, deduplicates polls, and avoids duplicate prose on completion", async () => {
    const root = createTempRoot();
    const desktopDir = path.join(root, "antigravity");
    const projectDir = path.join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const stateDb = new StateDb(path.join(root, "state.db"));
    const store = new AntigravityStore(stateDb.db);
    const tgStore = new AntigravityTelegramStore(stateDb.db);
    const tg = createFakeTelegram();

    const sessionId = "e9f53d80-2d9a-48e7-b5b6-38e29fe698c3";
    const allowedProjects = [{ id: "proj-1", name: "proj-1", rootPath: projectDir }];
    store.upsertProject({ id: "proj-1", name: "proj-1", rootPath: projectDir, policyVersion: "v1", updatedAt: 100 });

    writeDesktopState({
      desktopDir,
      sessionId,
      projectDir,
      title: "Single Question Task",
      status: "CASCADE_RUN_STATUS_RUNNING",
      steps: [
        { step_index: 1, type: "USER_INPUT", content: "开始设计", created_at: "2026-11-11T11:59:00Z" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "请确认存储方式：",
          tool_calls: [
            {
              name: "ask_question",
              args: { questions: [{ question: "使用哪种数据库？", options: ["SQLite", "PostgreSQL"], is_multi_select: false }] },
            },
          ],
          created_at: "2026-11-11T12:00:00Z",
        },
      ],
    });

    const reader = new AntigravityDesktopReader({
      desktopAppDataDir: desktopDir,
      getAllowedProjects: () => allowedProjects,
    });

    const sentCalls: Array<{ id: string; prompt: string; options?: SourceSendOptions }> = [];
    const fakeSessionManager = {
      async send(id: string, _opId: string, prompt: string, options?: SourceSendOptions): Promise<SourceResult> {
        sentCalls.push({ id, prompt, ...(options ? { options } : {}) });
        return { state: "queued", sessionId: id, turnId: "exec-1" };
      },
      async create(): Promise<SourceResult> {
        return { state: "failed", sessionId: null };
      },
    };

    const config = loadAntigravityConfig({
      SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_DESKTOP_APP_DATA_DIR: desktopDir,
    });
    const replyRouter = new AntigravityReplyRouter({
      tgStore,
      externalSessionsEnabled: true,
      sessionManager: fakeSessionManager,
    });
    const observer = new AntigravityDesktopObserver({
      store,
      tgStore,
      approvalBridge: new AntigravityApprovalBridge(store),
      desktopReader: reader,
      telegram: tg.client,
      chatId: "1001",
      replyEnabled: true,
      externalSessionsEnabled: true,
    });
    const handler = new AntigravityTelegramHandler({
      config,
      store,
      tgStore,
      capabilityGate: new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true }),
      modelCatalog: new AntigravityModelCatalog({ cliPath: "/bin/echo" }),
      approvalBridge: new AntigravityApprovalBridge(store),
      newSessions: new AntigravityNewSessionManager({
        store,
        tgStore,
        modelCatalog: new AntigravityModelCatalog({ cliPath: "/bin/echo" }),
        sessionManager: fakeSessionManager as never,
      }),
      replyRouter,
      sessionManager: fakeSessionManager,
      observer,
      telegram: tg.client,
    });

    await observer.pollOnce();
    await observer.pollOnce(); // Repeated poll MUST NOT duplicate notification
    expect(tg.sent).toHaveLength(1);
    const qMsg = tg.sent[0]!;
    expect(qMsg.text).toContain("❓ Antigravity 等待输入");
    expect(qMsg.text).toContain("使用哪种数据库？");
    const flatButtons = (qMsg.buttons ?? []).flat();
    const opt2Btn = flatButtons.find((b) => b.text.includes("PostgreSQL"));
    expect(opt2Btn).toBeDefined();

    // Clicking option 2 submits immediately (1-click)
    await handler.tryHandleCallback(1, 1001, "cb-1", qMsg.messageId, opt2Btn!.callback_data);
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0]!.prompt).toBe("PostgreSQL");

    // Simulate turn finishing in Desktop -> only the NEW completion reply is notified, NOT "请确认存储方式：" again
    writeDesktopState({
      desktopDir,
      sessionId,
      projectDir,
      title: "Single Question Task",
      status: "CASCADE_RUN_STATUS_IDLE",
      steps: [
        { step_index: 1, type: "USER_INPUT", content: "开始设计", created_at: "2026-11-11T11:59:00Z" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "请确认存储方式：",
          tool_calls: [
            {
              name: "ask_question",
              args: { questions: [{ question: "使用哪种数据库？", options: ["SQLite", "PostgreSQL"], is_multi_select: false }] },
            },
          ],
          created_at: "2026-11-11T12:00:00Z",
        },
        { step_index: 3, type: "USER_INPUT", content: "PostgreSQL", created_at: "2026-11-11T12:01:00Z" },
        { step_index: 4, type: "PLANNER_RESPONSE", content: "已完成 PostgreSQL 迁移。", created_at: "2026-11-11T12:02:00Z" },
      ],
    });

    const countBeforeIdle = tg.sent.length;
    await observer.pollOnce();
    const idleMessages = tg.sent.slice(countBeforeIdle);
    expect(idleMessages).toHaveLength(1);
    expect(idleMessages[0]!.text).toContain("已完成 PostgreSQL 迁移。");
    expect(idleMessages[0]!.text).not.toContain("请确认存储方式：");
    stateDb.close();
  });

  test("supports multi-question + multi-select paginated wizard, ForceReply shorthand expansion, and 1A force-takeover confirmation", async () => {
    const root = createTempRoot();
    const desktopDir = path.join(root, "antigravity");
    const projectDir = path.join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const stateDb = new StateDb(path.join(root, "state.db"));
    const store = new AntigravityStore(stateDb.db);
    const tgStore = new AntigravityTelegramStore(stateDb.db);
    const tg = createFakeTelegram();

    const sessionId = "f1f2f3f4-2d9a-48e7-b5b6-38e29fe698c3";
    const allowedProjects = [{ id: "proj-1", name: "proj-1", rootPath: projectDir }];
    store.upsertProject({ id: "proj-1", name: "proj-1", rootPath: projectDir, policyVersion: "v1", updatedAt: 100 });

    writeDesktopState({
      desktopDir,
      sessionId,
      projectDir,
      title: "Multi Question Wizard Task",
      status: "CASCADE_RUN_STATUS_RUNNING",
      steps: [
        { step_index: 1, type: "USER_INPUT", content: "配置通知", created_at: "2026-11-11T11:59:00Z" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "请确认以下 2 个问题：",
          tool_calls: [
            {
              name: "ask_question",
              args: {
                questions: [
                  { question: "并发接管策略？", options: ["自动检测冲突", "总是静默重启"], is_multi_select: false },
                  { question: "启用哪些通知渠道？", options: ["Web", "Telegram", "DingTalk"], is_multi_select: true },
                ],
              },
            },
          ],
          created_at: "2026-11-11T12:00:00Z",
        },
      ],
    });

    const reader = new AntigravityDesktopReader({
      desktopAppDataDir: desktopDir,
      getAllowedProjects: () => allowedProjects,
    });

    let requireForceConfirmation = true;
    const sentCalls: Array<{ id: string; prompt: string; options?: SourceSendOptions }> = [];
    const fakeSessionManager = {
      async send(id: string, _opId: string, prompt: string, options?: SourceSendOptions): Promise<SourceResult> {
        sentCalls.push({ id, prompt, ...(options ? { options } : {}) });
        if (requireForceConfirmation && !options?.forceDesktopTakeover) {
          return { state: "failed", sessionId: id, errorCode: "desktop_takeover_confirm_required" };
        }
        return { state: "queued", sessionId: id, turnId: "exec-2" };
      },
      async create(): Promise<SourceResult> {
        return { state: "failed", sessionId: null };
      },
    };

    const config = loadAntigravityConfig({
      SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_DESKTOP_APP_DATA_DIR: desktopDir,
    });
    const replyRouter = new AntigravityReplyRouter({
      tgStore,
      externalSessionsEnabled: true,
      sessionManager: fakeSessionManager,
    });
    const observer = new AntigravityDesktopObserver({
      store,
      tgStore,
      approvalBridge: new AntigravityApprovalBridge(store),
      desktopReader: reader,
      telegram: tg.client,
      chatId: "1001",
      replyEnabled: true,
      externalSessionsEnabled: true,
    });
    const handler = new AntigravityTelegramHandler({
      config,
      store,
      tgStore,
      capabilityGate: new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true }),
      modelCatalog: new AntigravityModelCatalog({ cliPath: "/bin/echo" }),
      approvalBridge: new AntigravityApprovalBridge(store),
      newSessions: new AntigravityNewSessionManager({
        store,
        tgStore,
        modelCatalog: new AntigravityModelCatalog({ cliPath: "/bin/echo" }),
        sessionManager: fakeSessionManager as never,
      }),
      replyRouter,
      sessionManager: fakeSessionManager,
      observer,
      telegram: tg.client,
    });

    await observer.pollOnce();
    expect(tg.sent).toHaveLength(1);
    const wizMsg = tg.sent[0]!;

    // 1. Click "💬 回复" -> creates ForceReply message linked to qmeta, and replying "2 1+3" expands shorthand!
    const replyBtn = (wizMsg.buttons ?? []).flat().find((b) => b.text.includes("回复"));
    expect(replyBtn).toBeDefined();
    await handler.tryHandleCallback(10, 1001, "cb-reply", wizMsg.messageId, replyBtn!.callback_data);
    const forceReplyMsg = tg.sent.at(-1)!;
    requireForceConfirmation = false;
    const shorthandRes = await replyRouter.deliver(11, "1001", forceReplyMsg.messageId, "2 1+3");
    expect(shorthandRes).toEqual({ status: "delivered", sessionId });
    expect(sentCalls.at(-1)?.prompt).toBe("A1: 总是静默重启\nA2: Web；DingTalk");

    // 2. Now exercise the in-place wizard buttons WITH 1A conflict -> force confirmation -> forced submit!
    requireForceConfirmation = true;
    const q1Opt1 = (wizMsg.buttons ?? []).flat().find((b) => b.text.includes("自动检测冲突"));
    expect(q1Opt1).toBeDefined();

    // Tapping Q1 option 1 auto-advances keyboard to Q2 via editMessageReplyMarkup
    await handler.tryHandleCallback(20, 1001, "cb-q1", wizMsg.messageId, q1Opt1!.callback_data);
    let latestButtons = (tg.editedMarkup.at(-1)?.buttons ?? []).flat();
    const q2Web = latestButtons.find((b) => b.text.includes("Web"));
    expect(q2Web).toBeDefined();

    // Toggle Web (1) and Telegram (2) on multi-select Q2
    await handler.tryHandleCallback(21, 1001, "cb-q2-1", wizMsg.messageId, q2Web!.callback_data);
    latestButtons = (tg.editedMarkup.at(-1)?.buttons ?? []).flat();
    const q2Tg = latestButtons.find((b) => b.text.includes("Telegram"));
    await handler.tryHandleCallback(22, 1001, "cb-q2-2", wizMsg.messageId, q2Tg!.callback_data);

    // Click "✅ 提交回答" -> hits desktop_takeover_confirm_required -> renders force takeover buttons
    latestButtons = (tg.editedMarkup.at(-1)?.buttons ?? []).flat();
    const submitBtn = latestButtons.find((b) => b.text.includes("提交回答"));
    expect(submitBtn).toBeDefined();
    await handler.tryHandleCallback(23, 1001, "cb-submit", wizMsg.messageId, submitBtn!.callback_data);

    const confirmMsg = tg.sent.at(-1)!;
    expect(confirmMsg.text).toContain("正在运行");
    const forceBtn = (confirmMsg.buttons ?? []).flat().find((b) => b.text.includes("强制重启桌面端并提交"));
    expect(forceBtn).toBeDefined();

    // Click "⚠️ 强制重启桌面端并提交" -> sends with forceDesktopTakeover: true!
    await handler.tryHandleCallback(24, 1001, "cb-force", confirmMsg.messageId, forceBtn!.callback_data);
    expect(sentCalls.at(-1)).toEqual({
      id: sessionId,
      prompt: "A1: 自动检测冲突\nA2: Web；Telegram",
      options: { forceDesktopTakeover: true, notifyChatId: "1001" },
    });
    stateDb.close();
  });
});

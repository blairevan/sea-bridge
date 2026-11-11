import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import { loadAntigravityConfig } from "../src/antigravity/config.ts";
import { AntigravityDesktopReader } from "../src/antigravity/desktop-reader.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import {
  expandQuestionShorthandReply,
  extractAskQuestionPrompts,
  formatAntigravityQuestionAnswers,
  inspectPendingAskQuestion,
} from "../src/antigravity/question-parser.ts";
import { AntigravitySessionManager } from "../src/antigravity/session-manager.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";
import { LocalBridgeService } from "../src/bridge/service.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import { AntigravityWebSource } from "../src/web/sources/antigravity.ts";
import { WebStore } from "../src/web/store.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sea-agy-qparser-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setupSummariesDb(appDataDir: string, rows: Array<{
  id: string;
  title: string;
  workspaceUri: string;
  status: string;
  notFullyIdle: number;
  source?: string;
}>): void {
  const db = new Database(path.join(appDataDir, "conversation_summaries.db"));
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preview TEXT NOT NULL,
      step_count INTEGER NOT NULL,
      last_modified_time TEXT NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL,
      not_fully_idle INTEGER NOT NULL,
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      killed INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT ''
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO conversation_summaries(
      conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle, source
    ) VALUES (?, ?, '', 10, '2026-11-11T12:00:00Z', ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(r.id, r.title, JSON.stringify([r.workspaceUri]), r.status, r.notFullyIdle, r.source ?? "");
  }
  db.close();
}

describe("Antigravity ask_question parser & external session projection", () => {
  test("extractAskQuestionPrompts handles both object arrays and JSON-encoded strings", () => {
    const rawQuestions = [
      { question: "统一规范采用哪种？", options: ["(Recommended) 英文", "中文", "  "], is_multi_select: false },
      { question: "支持哪些渠道？", options: ["Web", "Telegram"], is_multi_select: true },
    ];

    const fromArray = extractAskQuestionPrompts([{ name: "ask_question", args: { questions: rawQuestions } }]);
    expect(fromArray).toEqual([
      { title: "统一规范采用哪种？", options: ["(Recommended) 英文", "中文"], multiSelect: false },
      { title: "支持哪些渠道？", options: ["Web", "Telegram"], multiSelect: true },
    ]);

    const fromJsonString = extractAskQuestionPrompts([
      { name: "read_file", args: { Path: "/tmp/a" } },
      { name: "ask_question", args: { questions: JSON.stringify(rawQuestions) } },
    ]);
    expect(fromJsonString).toEqual(fromArray);

    expect(extractAskQuestionPrompts([{ name: "ask_question", args: { questions: "{broken" } }])).toEqual([]);
  });

  test("formatAntigravityQuestionAnswers and expandQuestionShorthandReply support shorthand and free text", () => {
    const questions = [
      { title: "Q1", options: ["Opt1A", "Opt1B"], multiSelect: false },
      { title: "Q2", options: ["Opt2A", "Opt2B", "Opt2C"], multiSelect: true },
    ];

    expect(formatAntigravityQuestionAnswers(["OnlyOne"])).toBe("OnlyOne");
    expect(formatAntigravityQuestionAnswers(["Opt1A", "Opt2A；Opt2C"])).toBe("A1: Opt1A\nA2: Opt2A；Opt2C");

    expect(expandQuestionShorthandReply("2 1+3", questions)).toBe("A1: Opt1B\nA2: Opt2A；Opt2C");
    expect(expandQuestionShorthandReply("1, 2", questions)).toBe("A1: Opt1A\nA2: Opt2B");
    expect(expandQuestionShorthandReply("9 1", questions)).toBe("9 1");
    expect(expandQuestionShorthandReply("按默认方案处理，但第二项用自定义逻辑", questions)).toBe(
      "按默认方案处理，但第二项用自定义逻辑"
    );
  });

  test("hydrates truncated tool_calls from transcript_full.jsonl, preserves prose, and projects waiting_user_input + bridge compatibility", async () => {
    const root = createTempDir();
    const desktopDir = path.join(root, "antigravity");
    const projectDir = path.join(root, "toolhub");
    mkdirSync(desktopDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const convWaiting = "e9f53d80-2d9a-48e7-b5b6-38e29fe698c3";
    const convAnswered = "a1b2c3d4-2d9a-48e7-b5b6-38e29fe698c3";

    setupSummariesDb(desktopDir, [
      {
        id: convWaiting,
        title: "ToolHub Task Execution Source Alignment",
        workspaceUri: `file://${projectDir}`,
        status: "CASCADE_RUN_STATUS_RUNNING",
        notFullyIdle: 1,
      },
      {
        id: convAnswered,
        title: "Already Answered Session",
        workspaceUri: `file://${projectDir}`,
        status: "CASCADE_RUN_STATUS_RUNNING",
        notFullyIdle: 1,
      },
    ]);

    const writeLogs = (id: string, compact: unknown[], full: unknown[]) => {
      const logDir = path.join(desktopDir, "brain", id, ".system_generated", "logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(path.join(logDir, "transcript.jsonl"), compact.map((s) => JSON.stringify(s)).join("\n") + "\n");
      writeFileSync(path.join(logDir, "transcript_full.jsonl"), full.map((s) => JSON.stringify(s)).join("\n") + "\n");
    };

    const fullQuestions = [
      { question: "采用哪种来源展示规范？", options: ["(Recommended) 精简英文", "保留后缀"], is_multi_select: false },
      { question: "需要覆盖哪些端？", options: ["Web", "Telegram", "DingTalk"], is_multi_select: true },
    ];

    writeLogs(
      convWaiting,
      [
        { step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>对齐命名规范</USER_REQUEST>", created_at: "2026-11-11T11:58:00Z" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "请在下方确认以下 2 个设计细节：",
          tool_calls: [{ name: "ask_question", args: { questions: "[truncated]" } }],
          truncated_fields: ["thinking", "tool_calls"],
          created_at: "2026-11-11T12:00:00Z",
        },
      ],
      [
        { step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>对齐命名规范</USER_REQUEST>", created_at: "2026-11-11T11:58:00Z" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "请在下方确认以下 2 个设计细节：",
          tool_calls: [
            { name: "run_command", args: { CommandLine: "git status" } },
            { name: "ask_question", args: { questions: JSON.stringify(fullQuestions) } },
          ],
          created_at: "2026-11-11T12:00:00Z",
        },
      ]
    );

    writeLogs(
      convAnswered,
      [
        { step_index: 1, type: "USER_INPUT", content: "hi", created_at: "2026-11-11T11:50:00Z" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "",
          tool_calls: [{ name: "ask_question", args: { questions: fullQuestions } }],
          created_at: "2026-11-11T11:51:00Z",
        },
        { step_index: 3, type: "USER_INPUT", content: "A1: (Recommended) 精简英文", created_at: "2026-11-11T11:52:00Z" },
      ],
      []
    );

    expect(inspectPendingAskQuestion(desktopDir, convWaiting)).toHaveLength(2);
    expect(inspectPendingAskQuestion(desktopDir, convAnswered)).toEqual([]);

    const allowedProjects = [{ id: "toolhub", name: "toolhub", rootPath: projectDir }];
    const reader = new AntigravityDesktopReader({
      desktopAppDataDir: desktopDir,
      getAllowedProjects: () => allowedProjects,
    });

    const listed = reader.listSessions();
    const waitingItem = listed.find((s) => s.id === convWaiting);
    const runningItem = listed.find((s) => s.id === convAnswered);
    expect(waitingItem?.state).toBe("waiting_user_input");
    expect(runningItem?.state).toBe("running");

    const history = reader.readHistory(convWaiting);
    expect(history?.sessionState).toBe("waiting_user_input");
    expect(history?.activeTurnItems?.some((item) => item.text === "ask_question")).toBe(false);
    expect(history?.messages.map((m) => ({ id: m.id, text: m.text, qCount: m.questions?.length ?? 0 }))).toEqual([
      { id: "step-1-user", text: "对齐命名规范", qCount: 0 },
      { id: "step-2-assistant", text: "请在下方确认以下 2 个设计细节：", qCount: 0 },
      { id: "step-2-question", text: "", qCount: 2 },
    ]);

    // Verify AntigravityWebSource enables sendEnabled for waiting_user_input and LocalBridgeService maps to waiting_external_approval
    const db = new Database(":memory:");
    migrateAntigravityBridgeTables(db);
    migrateWeb(db);
    const webStore = new WebStore(db);
    const agyStore = new AntigravityStore(db);
    for (const p of allowedProjects) {
      agyStore.upsertProject({ id: p.id, name: p.name, rootPath: p.rootPath, policyVersion: "v1", updatedAt: 100 });
    }
    const gate = new AntigravityCapabilityGate({
      enabled: true,
      writeEnabled: true,
      desktopReadEnabled: true,
      externalSessionsEnabled: true,
    });
    const catalog = new AntigravityModelCatalog({ cliPath: "/bin/echo" });
    const bridge = new AntigravityApprovalBridge(agyStore);
    const sessionManager = new AntigravitySessionManager({
      store: agyStore,
      webStore,
      approvalBridge: bridge,
      capabilityGate: gate,
      modelCatalog: catalog,
      cliPath: "/bin/echo",
      desktopReader: reader,
      desktopAppDataDir: desktopDir,
      externalSessionsEnabled: true,
      getAllowedProjects: () => allowedProjects,
    });
    const config = loadAntigravityConfig({
      SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED: "true",
    });
    const webSource = new AntigravityWebSource({
      config,
      store: agyStore,
      webStore,
      capabilityGate: gate,
      modelCatalog: catalog,
      desktopReader: reader,
      approvalBridge: bridge,
      sessionManager,
    });

    const webSessions = await webSource.sessions();
    const projectedWaiting = webSessions.find((s) => s.id === convWaiting);
    expect(projectedWaiting?.state).toBe("waiting_user_input");
    expect(projectedWaiting?.sendEnabled).toBe(true);

    const pepper = new Uint8Array(32).fill(7);
    const redaction = new WebRedaction([]);
    const localBridge = new LocalBridgeService({
      store: webStore,
      auth: new WebAuth(webStore),
      events: new WebEvents(webStore),
      redaction,
      pepper,
      sources: { antigravity: webSource },
      webBaseUrl: null,
    });
    const summary = await localBridge.getSessionSummary("antigravity", convWaiting);
    expect(summary.state).toBe("waiting_external_approval");
    expect(summary.pendingApprovalsCount).toBeGreaterThanOrEqual(1);
    expect(summary.lastAssistantText).toBe("请在下方确认以下 2 个设计细节：");

    // Verify empty-prose PLANNER_RESPONSE still produces the standalone question card
    const convEmptyProse = "b2c3d4e5-2d9a-48e7-b5b6-38e29fe698c3";
    writeLogs(
      convEmptyProse,
      [
        { step_index: 1, type: "USER_INPUT", content: "start", created_at: "2026-11-11T12:01:00Z" },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "   ",
          tool_calls: [{ name: "ask_question", args: { questions: fullQuestions.slice(0, 1) } }],
          created_at: "2026-11-11T12:02:00Z",
        },
      ],
      []
    );
    const sdb = new Database(path.join(desktopDir, "conversation_summaries.db"));
    sdb
      .prepare(
        "INSERT INTO conversation_summaries(conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle, source) VALUES (?, 'Empty Prose', '', 2, '2026-11-11T12:02:00Z', ?, 'CASCADE_RUN_STATUS_RUNNING', 1, '')"
      )
      .run(convEmptyProse, JSON.stringify([`file://${projectDir}`]));
    sdb.close();

    const emptyProseHistory = reader.readHistory(convEmptyProse);
    expect(emptyProseHistory?.sessionState).toBe("waiting_user_input");
    expect(emptyProseHistory?.messages.map((m) => ({ id: m.id, text: m.text, qCount: m.questions?.length ?? 0 }))).toEqual([
      { id: "step-1-user", text: "start", qCount: 0 },
      { id: "step-2-question", text: "", qCount: 1 },
    ]);
    db.close();
  });
});

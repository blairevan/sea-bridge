import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import type { AcpClient, AcpClientCallbacks } from "../src/antigravity/client.ts";
import { loadAntigravityConfig } from "../src/antigravity/config.ts";
import { AntigravityDesktopAppController } from "../src/antigravity/desktop-app-controller.ts";
import { AntigravityDesktopReader } from "../src/antigravity/desktop-reader.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravitySessionManager } from "../src/antigravity/session-manager.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";
import { createWebHandler } from "../src/web/http.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import { AntigravityWebSource } from "../src/web/sources/antigravity.ts";
import { WebStore } from "../src/web/store.ts";
import { loginFixture } from "./helpers/web-login.ts";

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sea-agy-takeover-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function seedAppDataSession(params: {
  appDataDir: string;
  sessionId: string;
  projectDir: string;
  nativeProjectId?: string;
  status: "CASCADE_RUN_STATUS_RUNNING" | "CASCADE_RUN_STATUS_IDLE";
  source?: string;
  waitingQuestions?: Array<{ question: string; options: string[]; is_multi_select?: boolean }>;
  createLock?: boolean;
}): void {
  mkdirSync(params.appDataDir, { recursive: true });
  const dbPath = path.join(params.appDataDir, "conversation_summaries.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      killed INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(`
    INSERT OR REPLACE INTO conversation_summaries(
      conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
      status, project_id, source, not_fully_idle
    ) VALUES (?, ?, '', 4, '2026-11-11T12:00:00Z', ?, ?, ?, ?, ?)
  `).run(
    params.sessionId,
    `Session ${params.sessionId.slice(0, 8)}`,
    JSON.stringify([`file://${params.projectDir}`]),
    params.status,
    params.nativeProjectId ?? "",
    params.source ?? "",
    params.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0,
  );
  db.close();

  const logDir = path.join(params.appDataDir, "brain", params.sessionId, ".system_generated", "logs");
  mkdirSync(logDir, { recursive: true });
  const steps: unknown[] = [
    { step_index: 1, type: "USER_INPUT", content: "请开始任务", created_at: "2026-11-11T11:59:00Z" },
  ];
  if (params.waitingQuestions && params.waitingQuestions.length > 0) {
    steps.push({
      step_index: 2,
      type: "PLANNER_RESPONSE",
      content: "请确认以下问题：",
      tool_calls: [{ name: "ask_question", args: { questions: params.waitingQuestions } }],
      created_at: "2026-11-11T12:00:00Z",
    });
  } else {
    steps.push({
      step_index: 2,
      type: "PLANNER_RESPONSE",
      content: "正在执行构建...",
      tool_calls: [{ name: "run_command", args: { CommandLine: "bun test" } }],
      created_at: "2026-11-11T12:00:00Z",
    });
  }
  writeFileSync(path.join(logDir, "transcript.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");

  if (params.createLock) {
    const presenceDir = path.join(params.appDataDir, "presence");
    mkdirSync(presenceDir, { recursive: true });
    writeFileSync(path.join(presenceDir, `${params.sessionId}.lock`), "");
  }
}

function createFakeAcpFactory(events: string[]) {
  return (_gen: number, _cwd: string, callbacks: AcpClientCallbacks, appDataDir?: string): AcpClient => {
    let closed = false;
    return {
      start() {
        events.push(`worker:start:${appDataDir ?? "default"}`);
      },
      identity: () => ({ pid: 9001, startedAt: Date.now(), generation: 1, closed }),
      initialize: async () => ({
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.2" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, close: {} } },
      }),
      sessionNew: async () => ({ sessionId: randomUUID(), configOptions: [] }),
      sessionResume: async (id: string) => {
        events.push(`worker:resume:${id}`);
        return { sessionId: id, configOptions: [] };
      },
      sessionLoad: async (id: string) => ({ sessionId: id, configOptions: [] }),
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: (id: string, text: string) => ({
        rpcRequestId: "rpc-takeover-1",
        promise: (async () => {
          events.push(`worker:prompt:${text}`);
          callbacks.onSessionUpdate?.(
            {
              sessionId: id,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `已收到回答：${text}` } },
            },
            1,
          );
          return { stopReason: "end_turn" };
        })(),
      }),
      cancel: async () => {},
      closeSession: async (id: string) => {
        events.push(`worker:closeSession:${id}`);
      },
      close: () => {
        closed = true;
        events.push("worker:close");
      },
    } as unknown as AcpClient;
  };
}

describe("Antigravity Desktop Exclusive Lock Takeover & 1A Concurrency Protection", () => {
  test("auto-quits Antigravity.app before session/resume when no other Desktop session is running, then reopens after turn settles", async () => {
    const root = makeTempRoot();
    const desktopDir = path.join(root, "antigravity");
    const projectDir = path.join(root, "project");
    mkdirSync(projectDir, { recursive: true });

    const waitingId = "e9f53d80-2d9a-48e7-b5b6-38e29fe698c3";
    const otherWaitingId = "22222222-2d9a-48e7-b5b6-38e29fe698c3";
    const otherIdleId = "33333333-2d9a-48e7-b5b6-38e29fe698c3";
    const nativeProjectId = "43e4063c-f55e-4006-90df-7f7aea9ee9ad";

    seedAppDataSession({
      appDataDir: desktopDir,
      sessionId: waitingId,
      projectDir,
      nativeProjectId,
      status: "CASCADE_RUN_STATUS_RUNNING",
      waitingQuestions: [{ question: "选择哪种方案？", options: ["方案 A", "方案 B"] }],
      createLock: true,
    });
    // Another Desktop session in waiting_user_input and another in idle MUST NOT count as running conflict
    seedAppDataSession({
      appDataDir: desktopDir,
      sessionId: otherWaitingId,
      projectDir,
      status: "CASCADE_RUN_STATUS_RUNNING",
      waitingQuestions: [{ question: "另一会话问题", options: ["1", "2"] }],
    });
    seedAppDataSession({
      appDataDir: desktopDir,
      sessionId: otherIdleId,
      projectDir,
      status: "CASCADE_RUN_STATUS_IDLE",
    });

    const events: string[] = [];
    let desktopAppOpen = true;
    let settledPromiseResolve: (() => void) | null = null;
    const settledDone = new Promise<void>((resolve) => {
      settledPromiseResolve = resolve;
    });

    const allowedProjects = [{ id: "proj-1", name: "proj-1", rootPath: projectDir }];
    const reader = new AntigravityDesktopReader({
      desktopAppDataDir: desktopDir,
      getAllowedProjects: () => allowedProjects,
    });

    const controller = new AntigravityDesktopAppController({
      desktopAppDataDir: desktopDir,
      desktopReader: reader,
      sleepFn: async () => {},
      runCommand: async (cmd, args) => {
        if (cmd === "lsof") {
          return desktopAppOpen ? { exitCode: 0, stdout: "7100\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd === "pgrep") {
          return desktopAppOpen ? { exitCode: 0, stdout: "7099\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd === "ps") {
          return { exitCode: 0, stdout: "/Applications/Antigravity.app/Contents/MacOS/Antigravity\n", stderr: "" };
        }
        if (cmd === "osascript") {
          events.push("desktop:quit");
          desktopAppOpen = false;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd === "open") {
          events.push(`desktop:reopen:${args.join(" ")}`);
          desktopAppOpen = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const db = new Database(":memory:");
    migrateAntigravityBridgeTables(db);
    migrateWeb(db);
    const store = new AntigravityStore(db);
    store.upsertProject({ id: "proj-1", name: "proj-1", rootPath: projectDir, policyVersion: "v1", updatedAt: 100 });

    const manager = new AntigravitySessionManager({
      store,
      webStore: new WebStore(db),
      approvalBridge: new AntigravityApprovalBridge(store),
      capabilityGate: new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true }),
      modelCatalog: new AntigravityModelCatalog({ cliPath: "/bin/echo" }),
      cliPath: "/bin/echo",
      desktopReader: reader,
      desktopAppDataDir: desktopDir,
      desktopAppController: controller,
      externalSessionsEnabled: true,
      getAllowedProjects: () => allowedProjects,
      clientFactory: createFakeAcpFactory(events),
      onDesktopTurnSettled: (sid) => {
        void controller.onDesktopTurnSettled(sid).then(() => settledPromiseResolve?.());
      },
    });

    const res = await manager.send(waitingId, randomUUID(), "方案 A");
    expect(res.state).toBe("queued");

    await settledDone;

    // Verify exact ordering: quit BEFORE worker start/resume, and reopen AFTER closeSession
    const quitIdx = events.indexOf("desktop:quit");
    const resumeIdx = events.indexOf(`worker:resume:${waitingId}`);
    const reopenIdx = events.findIndex((e) => e.startsWith("desktop:reopen:"));
    expect(quitIdx).toBeGreaterThanOrEqual(0);
    expect(resumeIdx).toBeGreaterThan(quitIdx);
    expect(reopenIdx).toBeGreaterThan(resumeIdx);
    expect(events[reopenIdx]).toContain(`antigravity://open?project=${nativeProjectId}`);
    expect(desktopAppOpen).toBe(true);
    db.close();
  });

  test("returns desktop_takeover_confirm_required when another Desktop session is running, and succeeds over HTTP with forceDesktopTakeover: true", async () => {
    const root = makeTempRoot();
    const desktopDir = path.join(root, "antigravity");
    const cliDir = path.join(root, "antigravity-cli");
    const projectDir = path.join(root, "project");
    mkdirSync(projectDir, { recursive: true });

    const waitingDesktopId = "e9f53d80-2d9a-48e7-b5b6-38e29fe698c3";
    const runningDesktopId = "88888888-2d9a-48e7-b5b6-38e29fe698c3";
    const waitingCliId = "99999999-2d9a-48e7-b5b6-38e29fe698c3";

    seedAppDataSession({
      appDataDir: desktopDir,
      sessionId: waitingDesktopId,
      projectDir,
      status: "CASCADE_RUN_STATUS_RUNNING",
      waitingQuestions: [{ question: "确认桌面端问题？", options: ["确认", "取消"] }],
      createLock: true,
    });
    seedAppDataSession({
      appDataDir: desktopDir,
      sessionId: runningDesktopId,
      projectDir,
      status: "CASCADE_RUN_STATUS_RUNNING",
    });
    seedAppDataSession({
      appDataDir: cliDir,
      sessionId: waitingCliId,
      projectDir,
      status: "CASCADE_RUN_STATUS_RUNNING",
      source: "CORTEX_TRAJECTORY_SOURCE_CLI",
      waitingQuestions: [{ question: "确认 CLI 问题？", options: ["CLI-A", "CLI-B"] }],
      createLock: true,
    });

    const events: string[] = [];
    let desktopAppOpen = true;
    const allowedProjects = [{ id: "proj-1", name: "proj-1", rootPath: projectDir }];
    const reader = new AntigravityDesktopReader({
      desktopAppDataDir: desktopDir,
      cliAppDataDir: cliDir,
      getAllowedProjects: () => allowedProjects,
    });

    const controller = new AntigravityDesktopAppController({
      desktopAppDataDir: desktopDir,
      desktopReader: reader,
      sleepFn: async () => {},
      runCommand: async (cmd) => {
        if (cmd === "lsof" || cmd === "pgrep") {
          return desktopAppOpen ? { exitCode: 0, stdout: "7100\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd === "ps") {
          return { exitCode: 0, stdout: "/Applications/Antigravity.app/Contents/MacOS/Antigravity\n", stderr: "" };
        }
        if (cmd === "osascript") {
          events.push("desktop:quit");
          desktopAppOpen = false;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd === "open") {
          events.push("desktop:reopen");
          desktopAppOpen = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const db = new Database(":memory:");
    migrateAntigravityBridgeTables(db);
    migrateWeb(db);
    const store = new AntigravityStore(db);
    store.upsertProject({ id: "proj-1", name: "proj-1", rootPath: projectDir, policyVersion: "v1", updatedAt: 100 });
    const webStore = new WebStore(db);
    const gate = new AntigravityCapabilityGate({
      enabled: true,
      writeEnabled: true,
      desktopReadEnabled: true,
      externalSessionsEnabled: true,
    });
    const catalog = new AntigravityModelCatalog({ cliPath: "/bin/echo" });
    const approvalBridge = new AntigravityApprovalBridge(store);

    const manager = new AntigravitySessionManager({
      store,
      webStore,
      approvalBridge,
      capabilityGate: gate,
      modelCatalog: catalog,
      cliPath: "/bin/echo",
      appDataDir: "antigravity-cli",
      desktopReader: reader,
      desktopAppDataDir: desktopDir,
      desktopAppController: controller,
      externalSessionsEnabled: true,
      getAllowedProjects: () => allowedProjects,
      clientFactory: createFakeAcpFactory(events),
    });

    // 1. CLI session in waiting_user_input NEVER quits Antigravity.app even when Desktop has a running session
    const cliRes = await manager.send(waitingCliId, randomUUID(), "CLI-A");
    expect(cliRes.state).toBe("queued");
    expect(events).not.toContain("desktop:quit");
    expect(desktopAppOpen).toBe(true);

    // 2. HTTP Web handler: GET /api/sessions?activity=waiting_user_input works,
    //    first POST without forceDesktopTakeover returns desktop_takeover_confirm_required,
    //    second POST with forceDesktopTakeover: true succeeds!
    const config = loadAntigravityConfig({
      SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED: "true",
      SEA_BRIDGE_ANTIGRAVITY_DESKTOP_APP_DATA_DIR: desktopDir,
    });
    const webSource = new AntigravityWebSource({
      config,
      store,
      webStore,
      capabilityGate: gate,
      modelCatalog: catalog,
      desktopReader: reader,
      approvalBridge,
      sessionManager: manager,
    });

    const pepper = new Uint8Array(32).fill(9);
    const auth = new WebAuth(webStore);
    const paired = await loginFixture(auth);
    const cookieHeader = `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}`;
    const handler = createWebHandler({
      store: webStore,
      auth,
      events: new WebEvents(webStore),
      redaction: new WebRedaction([]),
      pepper,
      sources: { antigravity: webSource },
      port: 8787,
      remoteOrigin: null,
      telegramStatus: () => ({ stopped: false, lastPollSuccessAt: null, pollFailed: false }),
    });

    const filterResp = await handler(
      new Request("http://127.0.0.1:8787/api/sessions?activity=waiting_user_input", {
        headers: { Origin: "http://127.0.0.1:8787", Cookie: cookieHeader },
      }),
      "127.0.0.1",
    );
    expect(filterResp.status).toBe(200);
    const filterPayload = (await filterResp.json()) as { data: { items: Array<{ id: string; state: string }> } };
    expect(filterPayload.data.items.some((s) => s.id === waitingDesktopId && s.state === "waiting_user_input")).toBe(true);

    const blockedResp = await handler(
      new Request(`http://127.0.0.1:8787/api/sessions/antigravity/${waitingDesktopId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8787",
          Cookie: cookieHeader,
          "X-Sea-Bridge-CSRF": paired.csrfToken,
        },
        body: JSON.stringify({ operationId: randomUUID(), prompt: "确认" }),
      }),
      "127.0.0.1",
    );
    expect(blockedResp.status).toBe(200);
    const blockedOp = (await blockedResp.json()) as { data: { state: string; errorCode: string } };
    expect(blockedOp.data.state).toBe("failed");
    expect(blockedOp.data.errorCode).toBe("desktop_takeover_confirm_required");
    expect(desktopAppOpen).toBe(true);

    const forcedResp = await handler(
      new Request(`http://127.0.0.1:8787/api/sessions/antigravity/${waitingDesktopId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8787",
          Cookie: cookieHeader,
          "X-Sea-Bridge-CSRF": paired.csrfToken,
        },
        body: JSON.stringify({ operationId: randomUUID(), prompt: "确认", forceDesktopTakeover: true }),
      }),
      "127.0.0.1",
    );
    expect(forcedResp.status).toBe(200);
    const forcedOp = (await forcedResp.json()) as { data: { state: string } };
    expect(["queued", "accepted"]).toContain(forcedOp.data.state);
    expect(events).toContain("desktop:quit");
    db.close();
  });
});

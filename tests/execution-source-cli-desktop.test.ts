import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { randomBytes, randomUUID } from "node:crypto";
import { StateDb } from "../src/state/db.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import { CodexWebSource } from "../src/web/sources/codex.ts";
import { AntigravityWebSource } from "../src/web/sources/antigravity.ts";
import { LocalBridgeService } from "../src/bridge/service.ts";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import type { AcpClient, AcpClientCallbacks } from "../src/antigravity/client.ts";
import type { AntigravityConfig } from "../src/antigravity/config.ts";
import { AntigravityDesktopReader } from "../src/antigravity/desktop-reader.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravitySessionManager } from "../src/antigravity/session-manager.ts";
import { AntigravityStore } from "../src/antigravity/store.ts";
import type { CodexThread } from "../src/desktop/codex-thread-store.ts";

function buildMockAcpClient(
  callbacks: AcpClientCallbacks,
  nextSessionId: () => string,
  stats: { closedWorkers: number }
): AcpClient {
  let closed = false;
  return {
    start() {},
    identity: () => ({ pid: 5511, startedAt: Date.now(), generation: 1, closed }),
    initialize: async () => ({
      protocolVersion: 1,
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.3" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, close: {} } },
    }),
    sessionNew: async () => ({
      sessionId: nextSessionId(),
      configOptions: [
        { id: "model", name: "Model", currentValue: "gemini-4-argon", options: [{ value: "gemini-4-argon", label: "Gemini 4 Argon" }] },
        { id: "thought_level", name: "Thought", currentValue: "medium", options: [{ value: "medium", label: "Medium" }] },
      ],
    }),
    sessionResume: async (id: string) => ({ sessionId: id, configOptions: [] }),
    sessionLoad: async (id: string) => ({ sessionId: id, configOptions: [] }),
    setConfigOption: async (_id: string, _cfg: string, val: string) => ({
      configOptions: [
        { id: "model", name: "Model", currentValue: val, options: [] },
        { id: "thought_level", name: "Thought", currentValue: "high", options: [] },
      ],
    }),
    prompt: (id: string, text: string) => ({
      rpcRequestId: "rpc-test",
      promise: (async () => {
        callbacks.onSessionUpdate?.(
          { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Reply: ${text}` } } },
          1
        );
        return { stopReason: "end_turn" };
      })(),
    }),
    cancel: async () => {},
    closeSession: async () => {},
    close: () => {
      closed = true;
      stats.closedWorkers++;
    },
  } as unknown as AcpClient;
}

describe("Execution Source CLI vs Desktop (v1.5.0)", () => {
  test("Codex + LocalBridgeService distinguishes clientTarget desktop vs cli and guards openDesktop", async () => {
    const db = new Database(":memory:");
    migrateWeb(db);
    const store = new WebStore(db);
    const auth = new WebAuth(store);
    const events = new WebEvents(store);
    const redaction = new WebRedaction([]);
    const threads = new Map<string, CodexThread>();
    let openedDesktopCount = 0;

    const codexSource = new CodexWebSource({
      openDesktop: async () => {
        openedDesktopCount++;
      },
      threads: {
        listActive: () => [...threads.values()],
        getThread: (id) => threads.get(id) ?? null,
      },
      catalogs: {
        listProjects: async () => [{ index: 1, id: "proj-1", name: "toolhub", roots: ["/repo"], primaryRoot: "/repo", position: 1 }],
        listModels: async () => [{ id: "gpt-5.4", displayName: "GPT-5.4", defaultReasoningEffort: "high", supportedReasoningEfforts: ["medium", "high"] }],
      },
      actions: {
        startThreadAndTurn: async (params) => {
          const threadId = randomUUID();
          threads.set(threadId, {
            id: threadId,
            rolloutPath: null,
            title: params.prompt,
            updatedAtMs: Date.now(),
            creationClient: { kind: "sea_bridge", evidence: "explicit" },
          });
          params.onThreadStarted?.(threadId);
          params.onOwnershipReleased?.(threadId, "turn-1");
          return { threadId, turnId: "turn-1", projectId: params.projectId, cwd: params.cwd, model: params.model ?? null };
        },
      },
      queue: { queue: async () => ({ status: "delivered", exitCode: 0 }) },
      sessionRoots: ["/repo"],
      pathExists: () => true,
      queueUsable: true,
      pendingApproval: () => false,
      catalogHealth: () => "ready",
      actionsAvailable: () => true,
      findCreatedClientTargets: () => store.findCreatedSessionTargets("codex"),
    });

    const bridge = new LocalBridgeService({
      store,
      auth,
      events,
      redaction,
      pepper: randomBytes(32),
      sources: { codex: codexSource },
      webBaseUrl: "http://127.0.0.1:7310",
    });

    const deskOp = await bridge.createSession({
      operationId: randomUUID(),
      source: "codex",
      clientTarget: "desktop",
      projectId: "proj-1",
      modelId: "gpt-5.4",
      prompt: "Desktop task",
    });
    const cliOp = await bridge.createSession({
      operationId: randomUUID(),
      source: "codex",
      clientTarget: "cli",
      projectId: "proj-1",
      modelId: "gpt-5.4",
      prompt: "CLI task",
    });

    const deskId = deskOp.sessionId!;
    const cliId = cliOp.sessionId!;
    expect(store.getCreatedSessionTarget("codex", deskId)).toBe("desktop");
    expect(store.getCreatedSessionTarget("codex", cliId)).toBe("cli");

    const listed = await codexSource.sessions();
    expect(listed.find((s) => s.id === deskId)?.creationClient).toEqual({ kind: "desktop", evidence: "explicit" });
    expect(listed.find((s) => s.id === cliId)?.creationClient).toEqual({ kind: "cli", evidence: "explicit" });

    const deskSummary = await bridge.getSessionSummary("codex", deskId);
    const cliSummary = await bridge.getSessionSummary("codex", cliId);
    expect(deskSummary.canOpenDesktop).toBe(true);
    expect(cliSummary.canOpenDesktop).toBe(false);

    await bridge.openDesktop(deskId);
    expect(openedDesktopCount).toBe(1);
    await expect(bridge.openDesktop(cliId)).rejects.toMatchObject({
      status: 409,
      errorCode: "desktop_open_cli_session",
    });
  });

  test("Antigravity creates into desktop vs cli appDataDir and aggregates external antigravity-cli history without polluting Desktop observer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sb-ag-target-"));
    const desktopDir = path.join(root, "antigravity");
    const cliDir = path.join(root, "antigravity-cli");
    mkdirSync(desktopDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    const state = new StateDb(path.join(root, "state.db"));

    try {
      const extCliId = "41aa6f7e-3277-4090-be02-8d5c03f7a111";
      const stubCliId = "52bb6f7e-3277-4090-be02-8d5c03f7a222";
      const cliSummaries = new Database(path.join(cliDir, "conversation_summaries.db"));
      cliSummaries.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
          step_count INTEGER NOT NULL DEFAULT 0, last_modified_time DATETIME NOT NULL, workspace_uris TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', parent_conversation_id TEXT NOT NULL DEFAULT '',
          nesting_depth INTEGER NOT NULL DEFAULT 0, not_fully_idle NUMERIC NOT NULL DEFAULT 0, killed NUMERIC NOT NULL DEFAULT 0
        );
      `);
      const ins = cliSummaries.query(
        "INSERT INTO conversation_summaries(conversation_id,title,preview,step_count,last_modified_time,workspace_uris,status,source,not_fully_idle) VALUES(?,?,?,?,?,?,?,?,?)"
      );
      ins.run(extCliId, "Local agy chat", "hello", 2, "2026-11-11T10:00:00Z", JSON.stringify(["file:///opt/app/aitools/toolhub"]), "CASCADE_RUN_STATUS_IDLE", "CORTEX_TRAJECTORY_SOURCE_CLI", 0);
      ins.run(stubCliId, "   ", "", 4, "2026-11-11T10:01:00Z", JSON.stringify(["file:///opt/app/aitools/toolhub"]), "CASCADE_RUN_STATUS_IDLE", "CORTEX_TRAJECTORY_SOURCE_CLI", 0);
      cliSummaries.close();

      const logDir = path.join(cliDir, "brain", extCliId, ".system_generated", "logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        path.join(logDir, "transcript.jsonl"),
        [
          JSON.stringify({ step_index: 1, type: "USER_INPUT", created_at: "2026-11-11T09:59:00Z", content: "CLI question" }),
          JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", created_at: "2026-11-11T09:59:10Z", content: "CLI answer" }),
        ].join("\n") + "\n"
      );

      const store = new AntigravityStore(state.db);
      store.upsertProject({ id: "toolhub", name: "toolhub", rootPath: "/opt/app/aitools/toolhub", policyVersion: "v1", updatedAt: 1 });
      const reader = new AntigravityDesktopReader({
        desktopAppDataDir: desktopDir,
        cliAppDataDir: cliDir,
        getAllowedProjects: () => store.listProjects(),
      });

      // Desktop-only observer list excludes CLI sessions
      expect(reader.listSessions()).toEqual([]);
      // Combined external list includes real CLI session and filters empty probe stub
      expect(reader.listExternalSessions().map((s) => ({ id: s.id, kind: s.creationClient?.kind }))).toEqual([
        { id: extCliId, kind: "cli" },
      ]);

      const spawnedDirs: Array<string | undefined> = [];
      const stats = { closedWorkers: 0 };
      let seq = 0;
      const catalog = new AntigravityModelCatalog({
        cliPath: "/bin/echo",
        runner: async () => "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n",
      });
      const gate = new AntigravityCapabilityGate({
        enabled: true,
        writeEnabled: true,
        desktopReadEnabled: true,
        externalSessionsEnabled: true,
      });
      gate.recordHandshake({
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.3" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
      });
      const approvals = new AntigravityApprovalBridge(store);
      let settledCount = 0;
      const mgr = new AntigravitySessionManager({
        store,
        approvalBridge: approvals,
        capabilityGate: gate,
        modelCatalog: catalog,
        cliPath: "/bin/echo",
        appDataDir: "antigravity-cli",
        desktopReader: reader,
        desktopAppDataDir: desktopDir,
        externalSessionsEnabled: true,
        getAllowedProjects: () => store.listProjects(),
        onDesktopTurnSettled: () => {
          settledCount++;
        },
        clientFactory: (_gen, _cwd, callbacks, appDataDir) => {
          spawnedDirs.push(appDataDir);
          return buildMockAcpClient(callbacks, () => `63cc6f7e-3277-4090-be02-8d5c03f7a00${++seq}`, stats);
        },
      });

      const agConfig: AntigravityConfig = {
        enabled: true,
        writeEnabled: true,
        cliPath: "/bin/echo",
        geminiDir: root,
        appDataDir: "antigravity-cli",
        desktopReadEnabled: true,
        desktopAppDataDir: desktopDir,
        maxActive: 4,
        approvalTimeoutMs: 60_000,
        externalSessionsEnabled: true,
        allowedProjects: [],
      };
      const webSource = new AntigravityWebSource({
        config: agConfig,
        store,
        sessionManager: mgr,
        capabilityGate: gate,
        modelCatalog: catalog,
        desktopReader: reader,
        approvalBridge: approvals,
      });
      expect(webSource.capabilities().desktopCreateEnabled).toBe(true);

      const deskCreated = await webSource.create({
        operationId: "op-desk",
        projectId: "toolhub",
        modelId: "gemini-4-argon-medium",
        prompt: "Run in Desktop",
        clientTarget: "desktop",
        onSessionKnown: () => {},
      });
      const cliCreated = await webSource.create({
        operationId: "op-cli",
        projectId: "toolhub",
        modelId: "gemini-4-argon-medium",
        prompt: "Run in CLI",
        clientTarget: "cli",
        onSessionKnown: () => {},
      });

      await Bun.sleep(30);
      expect(spawnedDirs).toEqual(["antigravity", "antigravity-cli"]);
      expect(stats.closedWorkers).toBe(1); // Desktop worker retired; CLI worker stays warm
      expect(settledCount).toBe(1);

      const sessions = await webSource.sessions();
      expect(sessions.find((s) => s.id === deskCreated.sessionId)?.creationClient?.kind).toBe("desktop");
      expect(sessions.find((s) => s.id === cliCreated.sessionId)?.creationClient?.kind).toBe("cli");
      expect(sessions.find((s) => s.id === extCliId)?.creationClient?.kind).toBe("cli");

      const extHistory = await webSource.history(extCliId, null, 20);
      expect(extHistory.messages.map((m) => m.text)).toEqual(["CLI question", "CLI answer"]);
      await mgr.shutdown();
    } finally {
      state.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("app.js parses 5-option creation targets and formats unified source labels", async () => {
    const script = await Bun.file("src/web/public/app.js").text();
    const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
    const ctx = runInNewContext(
      `${script.slice(0, end)}\n({ state, sourceDisplayName, parseCreateSelection, isCreateSelectionEnabled, sessionSourceLabel })`,
      { URL, URLSearchParams, location: { origin: "http://127.0.0.1:7310", search: "" }, document: { getElementById: () => null } }
    ) as {
      state: { caps: Record<string, Record<string, unknown>> };
      sourceDisplayName(s: string): string;
      parseCreateSelection(raw: string): { source: string; clientTarget: string | null };
      isCreateSelectionEnabled(raw: string): boolean;
      sessionSourceLabel(s: Record<string, unknown>): string;
    };
    ctx.state.caps = {
      codex: { createEnabled: true },
      antigravity: { createEnabled: true, desktopCreateEnabled: false, sendEnabled: true },
      dsh: { createEnabled: true },
    };
    expect(ctx.sourceDisplayName("dsh")).toBe("DSH");
    expect(ctx.parseCreateSelection("codex:desktop")).toEqual({ source: "codex", clientTarget: "desktop" });
    expect(ctx.parseCreateSelection("antigravity:cli")).toEqual({ source: "antigravity", clientTarget: "cli" });
    expect(ctx.isCreateSelectionEnabled("antigravity:desktop")).toBe(false);
    expect(ctx.isCreateSelectionEnabled("antigravity:cli")).toBe(true);
    expect(ctx.sessionSourceLabel({ source: "antigravity", sendEnabled: true, creationClient: { kind: "desktop" } })).toBe("Antigravity · Desktop");
    expect(ctx.sessionSourceLabel({ source: "antigravity", sendEnabled: false, state: "idle", creationClient: { kind: "cli" } })).toBe("Antigravity · CLI（只读）");
    expect(ctx.sessionSourceLabel({ source: "codex", creationClient: { kind: "cli" } })).toBe("Codex · CLI");
  });
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateDb } from "../src/state/db.ts";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import type { AcpClient, AcpClientCallbacks } from "../src/antigravity/client.ts";
import { AntigravityDesktopReader } from "../src/antigravity/desktop-reader.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravityReplyRouter } from "../src/antigravity/reply-router.ts";
import { AntigravitySessionManager } from "../src/antigravity/session-manager.ts";
import { AntigravityStore } from "../src/antigravity/store.ts";
import { AntigravityTelegramStore } from "../src/antigravity/telegram-store.ts";
import { AntigravityWebSource } from "../src/web/sources/antigravity.ts";

function createFakeClient(
  callbacks: AcpClientCallbacks,
  sessionId: string,
  stats: { closedSessions: string[]; workerClosed: number }
): AcpClient {
  let closed = false;
  return {
    start() {},
    identity: () => ({ pid: 4321, startedAt: Date.now(), generation: 1, closed }),
    initialize: async () => ({
      protocolVersion: 1,
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.3" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, close: {} } },
    }),
    sessionNew: async () => ({
      sessionId,
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
      rpcRequestId: "rpc-1",
      promise: (async () => {
        callbacks.onSessionUpdate?.(
          {
            sessionId: id,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Echo: ${text}` } },
          },
          1
        );
        return { stopReason: "end_turn" };
      })(),
    }),
    cancel: async () => {},
    closeSession: async (id: string) => {
      stats.closedSessions.push(id);
    },
    close: () => {
      closed = true;
      stats.workerClosed++;
    },
  } as unknown as AcpClient;
}

describe("P4 Antigravity Desktop & CLI External Session Write Interoperability", () => {
  test("filters CLI stubs, inspects external session state, and enforces P4 write gates + worker retirement", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "agy-p4-test-"));
    const desktopDir = path.join(tempRoot, "antigravity");
    mkdirSync(desktopDir, { recursive: true });
    const state = new StateDb(path.join(tempRoot, "state.db"));

    try {
      const deskIdleId = "179769f3-7ccb-4db6-a829-aa6baa9bac2d";
      const deskRunningId = "94a12d66-b809-4caa-a431-029ca63b2013";
      const deskUnallowedId = "c8b5c368-4d3e-4c60-9325-a849f93030d3";
      const cliStubId = "3e9defdb-c043-4db4-85d4-806573f33a9d";

      const summariesDb = new Database(path.join(desktopDir, "conversation_summaries.db"));
      summariesDb.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          step_count INTEGER NOT NULL DEFAULT 0,
          last_modified_time DATETIME NOT NULL,
          workspace_uris TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          parent_conversation_id TEXT NOT NULL DEFAULT '',
          nesting_depth INTEGER NOT NULL DEFAULT 0,
          not_fully_idle NUMERIC NOT NULL DEFAULT 0,
          killed NUMERIC NOT NULL DEFAULT 0
        );
      `);
      const ins = summariesDb.query(`
        INSERT INTO conversation_summaries(
          conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, source, not_fully_idle
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `);
      ins.run(deskIdleId, "Desktop Idle Session", "", 2, "2026-11-09T03:00:00Z", JSON.stringify(["file:///opt/app/aitools/sea-bridge"]), "CASCADE_RUN_STATUS_IDLE", "", 0);
      ins.run(deskRunningId, "Desktop Running Session", "", 4, "2026-11-09T03:01:00Z", JSON.stringify(["file:///opt/app/aitools/sea-bridge"]), "CASCADE_RUN_STATUS_RUNNING", "", 1);
      ins.run(deskUnallowedId, "Unallowed Workspace Session", "", 2, "2026-11-09T03:02:00Z", JSON.stringify(["file:///Users/zhuhaijun/other"]), "CASCADE_RUN_STATUS_IDLE", "", 0);
      ins.run(cliStubId, "", "", 10, "2026-11-09T03:03:00Z", JSON.stringify(["file:///opt/app/aitools/sea-bridge"]), "CASCADE_RUN_STATUS_IDLE", "CORTEX_TRAJECTORY_SOURCE_CLI", 0);
      summariesDb.close();

      // Seed transcript.jsonl for deskIdleId
      const logDir = path.join(desktopDir, "brain", deskIdleId, ".system_generated", "logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        path.join(logDir, "transcript.jsonl"),
        [
          JSON.stringify({ step_index: 1, type: "USER_INPUT", created_at: "2026-11-09T02:59:00Z", content: "Initial desktop question" }),
          JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", created_at: "2026-11-09T02:59:05Z", content: "Initial desktop answer" }),
        ].join("\n") + "\n"
      );

      const store = new AntigravityStore(state.db);
      const tgStore = new AntigravityTelegramStore(state.db);
      store.upsertProject({
        id: "sea-bridge",
        name: "SeaBridge",
        rootPath: "/opt/app/aitools/sea-bridge",
        policyVersion: "v1",
        updatedAt: 1000,
      });

      const reader = new AntigravityDesktopReader({
        desktopAppDataDir: desktopDir,
        getAllowedProjects: () => store.listProjects(),
      });

      // Verify CLI stub is filtered out
      const listed = reader.listSessions();
      expect(listed.map((s) => s.id)).toEqual([deskUnallowedId, deskRunningId, deskIdleId]);
      expect(reader.inspectExternalSession(cliStubId).found).toBe(false);
      expect(reader.inspectExternalSession(deskIdleId)).toMatchObject({
        found: true,
        externallyRunning: false,
        projectId: "sea-bridge",
        cwd: "/opt/app/aitools/sea-bridge",
      });
      expect(reader.inspectExternalSession(deskRunningId).externallyRunning).toBe(true);
      expect(reader.inspectExternalSession(deskUnallowedId).projectId).toBeNull();

      const catalog = new AntigravityModelCatalog({
        cliPath: "/bin/echo",
        runner: async () => "gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\n",
      });
      const gate = new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true });
      const approvals = new AntigravityApprovalBridge(store);

      const spawnedAppDataDirs: Array<string | undefined> = [];
      const stats = { closedSessions: [] as string[], workerClosed: 0 };

      // 1. When externalSessionsEnabled = false, desktop sessions remain strictly read-only
      const mgrDisabled = new AntigravitySessionManager({
        store,
        approvalBridge: approvals,
        capabilityGate: gate,
        modelCatalog: catalog,
        cliPath: "/bin/echo",
        appDataDir: "antigravity-cli",
        desktopReader: reader,
        desktopAppDataDir: desktopDir,
        externalSessionsEnabled: false,
        getAllowedProjects: () => store.listProjects(),
      });
      const webSourceDisabled = new AntigravityWebSource({
        config: {
          enabled: true,
          writeEnabled: true,
          cliPath: "/bin/echo",
          geminiDir: tempRoot,
          appDataDir: "antigravity-cli",
          desktopAppDataDir: desktopDir,
          desktopReadEnabled: true,
          maxActive: 1,
          approvalTimeoutMs: 30000,
          externalSessionsEnabled: false,
          allowedProjects: [],
        },
        store,
        capabilityGate: gate,
        modelCatalog: catalog,
        desktopReader: reader,
        approvalBridge: approvals,
        sessionManager: mgrDisabled,
      });

      const disabledList = await webSourceDisabled.sessions();
      expect(disabledList.find((s) => s.id === deskIdleId)?.sendEnabled).toBe(false);
      expect(await webSourceDisabled.send(deskIdleId, "op-ro-1", "test")).toEqual({
        state: "failed",
        sessionId: deskIdleId,
        errorCode: "desktop_session_read_only",
      });

      // 2. When externalSessionsEnabled = true, only idle desktop sessions in allowed projects unlock writing
      const mgrEnabled = new AntigravitySessionManager({
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
        clientFactory: (_gen, _cwd, cbs, appDataDir) => {
          spawnedAppDataDirs.push(appDataDir);
          return createFakeClient(cbs, deskIdleId, stats);
        },
      });
      const webSourceEnabled = new AntigravityWebSource({
        config: {
          enabled: true,
          writeEnabled: true,
          cliPath: "/bin/echo",
          geminiDir: tempRoot,
          appDataDir: "antigravity-cli",
          desktopAppDataDir: desktopDir,
          desktopReadEnabled: true,
          maxActive: 1,
          approvalTimeoutMs: 30000,
          externalSessionsEnabled: true,
          allowedProjects: [],
        },
        store,
        capabilityGate: gate,
        modelCatalog: catalog,
        desktopReader: reader,
        approvalBridge: approvals,
        sessionManager: mgrEnabled,
      });

      const enabledList = await webSourceEnabled.sessions();
      expect(enabledList.find((s) => s.id === deskIdleId)?.sendEnabled).toBe(true);
      expect(enabledList.find((s) => s.id === deskRunningId)?.sendEnabled).toBe(false);
      expect(enabledList.find((s) => s.id === deskUnallowedId)?.sendEnabled).toBe(false);

      // Running desktop session rejects concurrent write with session_busy
      expect(await webSourceEnabled.send(deskRunningId, "op-busy-1", "hi")).toEqual({
        state: "failed",
        sessionId: deskRunningId,
        errorCode: "session_busy",
      });

      // Unallowed workspace desktop session rejects write with invalid_project
      expect(await webSourceEnabled.send(deskUnallowedId, "op-unallowed-1", "hi")).toEqual({
        state: "failed",
        sessionId: deskUnallowedId,
        errorCode: "invalid_project",
      });

      // Idle allowed desktop session adopts in-place, uses appDataDir="antigravity", and retires worker after turn
      const modelRes = await webSourceEnabled.updateModel(deskIdleId, "gemini-4-argon", "high");
      expect(modelRes).toEqual({
        status: "updated",
        model: { id: "gemini-4-argon", displayName: "Gemini 4 Argon" },
        reasoningEffort: "high",
      });

      const sendRes = await webSourceEnabled.send(deskIdleId, "op-adopt-1", "Continue from SeaBridge Web");
      expect(sendRes.state).toBe("queued");
      expect(sendRes.sessionId).toBe(deskIdleId);

      // Wait for async prompt turn and closeSession/worker retirement
      await new Promise((r) => setTimeout(r, 30));

      expect(spawnedAppDataDirs).toEqual(["antigravity"]);
      expect(stats.closedSessions).toContain(deskIdleId);
      expect(stats.workerClosed).toBeGreaterThanOrEqual(1);

      // Session list still deduplicates and preserves creationClient: "desktop"
      const afterList = await webSourceEnabled.sessions();
      expect(afterList.filter((s) => s.id === deskIdleId)).toHaveLength(1);
      expect(afterList.find((s) => s.id === deskIdleId)?.creationClient?.kind).toBe("desktop");

      // History merges initial desktop transcript.jsonl + new SeaBridge turn
      const history = await webSourceEnabled.history(deskIdleId, null, 50);
      expect(history.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
        "user:Initial desktop question",
        "assistant:Initial desktop answer",
        "user:Continue from SeaBridge Web",
        "assistant:Echo: Continue from SeaBridge Web",
      ]);

      // Telegram reply to a desktop notification also succeeds when externalSessionsEnabled = true
      tgStore.linkMessage({
        chatId: "chat-1",
        messageId: 8801,
        sessionId: deskIdleId,
        sessionOrigin: "desktop",
        eventKind: "turn_completed",
        eventFingerprint: "fp-desk-8801",
      });
      const replyRouter = new AntigravityReplyRouter({
        tgStore,
        externalSessionsEnabled: true,
        sessionManager: mgrEnabled,
      });
      const tgReply = await replyRouter.deliver(9901, "chat-1", 8801, "Continue from Telegram");
      expect(tgReply).toEqual({ status: "delivered", sessionId: deskIdleId });
    } finally {
      state.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

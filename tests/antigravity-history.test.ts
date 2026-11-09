import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import type { AcpClient, AcpClientCallbacks } from "../src/antigravity/client.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { projectManagedWebHistory } from "../src/antigravity/projection.ts";
import { AntigravitySessionManager } from "../src/antigravity/session-manager.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";

const modelsFixture = readFileSync(path.join(import.meta.dir, "fixtures", "antigravity-acp", "agy-models.txt"), "utf8");

describe("Antigravity history projection and session/load replay", () => {
  test("replays history into a new snapshot generation atomically and preserves old snapshot on interrupted replay", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const approvalBridge = new AntigravityApprovalBridge(store);
      const capabilityGate = new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true });
      const modelCatalog = new AntigravityModelCatalog({
        cliPath: "/Users/zhuhaijun/.local/bin/agy",
        runner: async () => modelsFixture,
      });
      await modelCatalog.listModels();

      const sessionId = "28d79903-64e2-48e5-b8bb-d1bb0d585e6f";
      store.upsertSession({
        sessionId,
        nativeSessionId: sessionId,
        projectId: "proj-1",
        cwd: "/tmp",
        title: "Replay Test",
        modelId: "gemini-3.8-flash",
        reasoningEffort: "low",
        modeId: "default",
        status: "idle",
        completeHistory: true,
        snapshotGeneration: 1,
        createdAt: 100,
        updatedAt: 100,
      });

      let shouldFailReplay = false;
      const manager = new AntigravitySessionManager({
        store,
        approvalBridge,
        capabilityGate,
        modelCatalog,
        cliPath: "/bin/echo",
        getAllowedProjects: () => [{ id: "proj-1", name: "Proj", rootPath: "/tmp" }],
        clientFactory: (generation, _cwd, callbacks: AcpClientCallbacks) => {
          return {
            start() {},
            identity: () => ({ pid: 100, startedAt: 100, generation, closed: false }),
            initialize: async () => ({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
            }),
            sessionLoad: async () => {
              callbacks.onSessionUpdate?.(
                {
                  sessionId,
                  update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First question" } },
                },
                generation
              );
              callbacks.onSessionUpdate?.(
                {
                  sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First " } },
                },
                generation
              );
              callbacks.onSessionUpdate?.(
                {
                  sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
                },
                generation
              );
              if (shouldFailReplay) {
                throw new Error("replay_stream_broken");
              }
              callbacks.onSessionUpdate?.(
                {
                  sessionId,
                  update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "好的" } },
                },
                generation
              );
              callbacks.onSessionUpdate?.(
                {
                  sessionId,
                  update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "好的" } },
                },
                generation
              );
              return { sessionId };
            },
            close() {},
          } as unknown as AcpClient;
        },
      });

      // 1. Successful replay replaces snapshot generation 1 -> 2 and preserves duplicate identical messages ("好的")
      expect(await manager.reloadSessionHistory(sessionId)).toBe(true);
      const sessAfterSuccess = store.getSession(sessionId)!;
      expect(sessAfterSuccess.snapshotGeneration).toBe(2);
      expect(sessAfterSuccess.completeHistory).toBe(true);

      const history1 = projectManagedWebHistory({
        session: sessAfterSuccess,
        records: store.listMessages(sessionId),
        pendingApprovals: [],
        executionControl: manager.getExecutionControl(sessionId),
        catalog: modelCatalog,
        limit: 50,
      });

      expect(history1.sessionMeta).toEqual({
        model: { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
        reasoningEffort: "low",
      });
      expect(history1.messages.map((m) => ({ role: m.role, text: m.text }))).toEqual([
        { role: "user", text: "First question" },
        { role: "assistant", text: "First answer" },
        { role: "user", text: "好的" },
        { role: "user", text: "好的" },
      ]);

      // 2. Interrupted replay keeps snapshot generation 2 intact and marks completeHistory: false
      shouldFailReplay = true;
      expect(await manager.reloadSessionHistory(sessionId)).toBe(false);
      const sessAfterFail = store.getSession(sessionId)!;
      expect(sessAfterFail.snapshotGeneration).toBe(2);
      expect(sessAfterFail.completeHistory).toBe(false);
      expect(store.listMessages(sessionId)).toHaveLength(4);
    } finally {
      db.close();
    }
  });
});

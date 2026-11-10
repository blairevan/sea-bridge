import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import type { AcpClient, AcpClientCallbacks } from "../src/antigravity/client.ts";
import { loadAntigravityConfig } from "../src/antigravity/config.ts";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravitySessionManager } from "../src/antigravity/session-manager.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";

const modelsFixture = readFileSync(path.join(import.meta.dir, "fixtures", "antigravity-acp", "agy-models.txt"), "utf8");

describe("AntigravitySessionManager", () => {
  test("creates session with separated (modelId, reasoningEffort), transitions queued -> accepted, blocks concurrent send with session_busy, and supports exact interruptExecution", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      migrateWeb(db);
      const store = new AntigravityStore(db);
      const webStore = new WebStore(db);
      const approvalBridge = new AntigravityApprovalBridge(store);
      const capabilityGate = new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true });
      const modelCatalog = new AntigravityModelCatalog({
        cliPath: "/Users/zhuhaijun/.local/bin/agy",
        runner: async () => modelsFixture,
      });

      const setConfigCalls: Array<{ configId: string; value: string }> = [];
      let resolvePrompt!: (value: { stopReason: string }) => void;
      let currentCallbacks!: AcpClientCallbacks;
      let currentGeneration = 0;
      let closedGenerations: number[] = [];

      const manager = new AntigravitySessionManager({
        store,
        webStore,
        approvalBridge,
        capabilityGate,
        modelCatalog,
        cliPath: "/bin/echo",
        getAllowedProjects: () => [{ id: "proj-1", name: "SeaBridge", rootPath: "/opt/app/aitools/sea-bridge" }],
        clientFactory: (generation, _cwd, callbacks) => {
          currentGeneration = generation;
          currentCallbacks = callbacks;
          return {
            start() {},
            identity: () => ({ pid: 1000 + generation, startedAt: Date.now(), generation, closed: closedGenerations.includes(generation) }),
            initialize: async () => ({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
            }),
            sessionNew: async () => ({
              sessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85",
              configOptions: [
                { id: "model", name: "Model", type: "select", currentValue: "gemini-4-argon", options: [] },
                { id: "thought_level", name: "Thinking Level", type: "select", currentValue: "medium", options: [] },
              ],
            }),
            sessionResume: async (sessionId: string) => ({ sessionId }),
            setConfigOption: async (_sessionId: string, configId: string, value: string) => {
              setConfigCalls.push({ configId, value });
              return {
                configOptions: [
                  { id: "model", name: "Model", type: "select", currentValue: "claude-opus-5-5", options: [] },
                  { id: "thought_level", name: "Thinking Level", type: "select", currentValue: "high", options: [] },
                ],
              };
            },
            prompt: () => ({
              rpcRequestId: "1",
              promise: new Promise((resolve) => {
                resolvePrompt = resolve;
              }),
            }),
            cancel: async () => {
              resolvePrompt({ stopReason: "cancelled" });
            },
            close: () => {
              closedGenerations.push(generation);
            },
          } as unknown as AcpClient;
        },
      });

      // Claim and transition web operation to queued via create()
      webStore.claimOperation({
        id: "op-create-1",
        digest: "d1",
        kind: "create",
        source: "antigravity",
        deviceId: "dev-1",
        targetId: null,
        projectId: "proj-1",
        modelId: "claude-opus-5-5",
        createdAt: 100,
      });
      webStore.transitionOperation("op-create-1", "received", "dispatching", 101);

      let knownSessionId = "";
      const createRes = await manager.create({
        operationId: "op-create-1",
        projectId: "proj-1",
        modelId: "claude-opus-5-5",
        reasoningEffort: "high",
        prompt: "Build ACP integration",
        onSessionKnown: (id) => {
          knownSessionId = id;
          webStore.setOperationSession("op-create-1", id, 102);
        },
      });

      expect(knownSessionId).toBe("9d3547fd-5f23-4178-b143-38a82ad31d85");
      expect(createRes.state).toBe("queued");
      expect(createRes.sessionId).toBe("9d3547fd-5f23-4178-b143-38a82ad31d85");
      expect(setConfigCalls).toEqual([
        { configId: "model", value: "claude-opus-5-5" },
        { configId: "thought_level", value: "high" },
      ]);

      webStore.transitionOperation("op-create-1", "dispatching", "queued", 103);

      // While first turn is in-flight, concurrent send() returns session_busy
      const busyRes = await manager.send("9d3547fd-5f23-4178-b143-38a82ad31d85", "op-send-busy", "Another message");
      expect(busyRes).toEqual({
        state: "failed",
        sessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85",
        errorCode: "session_busy",
      });

      // Emit first streaming chunk -> transitions web_operations from queued -> accepted!
      currentCallbacks.onSessionUpdate?.(
        {
          sessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it..." } },
        },
        currentGeneration
      );
      expect(webStore.getOperation("op-create-1")?.state).toBe("accepted");

      // Wrong executionId or epoch in interruptExecution is rejected
      await expect(
        manager.interruptExecution("9d3547fd-5f23-4178-b143-38a82ad31d85", "wrong-exec-id", 1)
      ).rejects.toThrow("active_execution_changed");

      // Exact executionId + epoch cancels the turn and retires generation 1 worker
      const ctrl = manager.getExecutionControl("9d3547fd-5f23-4178-b143-38a82ad31d85");
      expect(ctrl.activeExecutionId).toBe(createRes.turnId!);
      expect(ctrl.activeEpoch).toBe(1);

      const intRes = await manager.interruptExecution(
        "9d3547fd-5f23-4178-b143-38a82ad31d85",
        ctrl.activeExecutionId!,
        ctrl.activeEpoch!
      );
      expect(intRes).toEqual({ status: "interrupting" });

      // Wait microtask for cancel promise resolution
      await new Promise((r) => setTimeout(r, 10));
      expect(store.getExecution(createRes.turnId!)?.status).toBe("cancelled");
      expect(store.getSession("9d3547fd-5f23-4178-b143-38a82ad31d85")?.status).toBe("idle");
      expect(closedGenerations).toContain(1);

      // Next send() spawns generation 2 and resumes the same nativeSessionId
      const send2 = await manager.send("9d3547fd-5f23-4178-b143-38a82ad31d85", "op-send-2", "Continue on gen 2");
      expect(send2.state).toBe("queued");
      expect(currentGeneration).toBe(2);
      resolvePrompt({ stopReason: "end_turn" });
      await new Promise((r) => setTimeout(r, 10));
      expect(store.getExecution(send2.turnId!)?.status).toBe("completed");
    } finally {
      db.close();
    }
  });

  test("aligns approvalPolicy with Desktop Turbo config and auto-approves permission requests without queueing approval cards", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "agy-turbo-cfg-"));
    const db = new Database(":memory:");
    try {
      mkdirSync(path.join(tmp, "config"), { recursive: true });
      writeFileSync(
        path.join(tmp, "config", "config.json"),
        JSON.stringify({ userSettings: { permissionPreset: "AGENT_PERMISSION_PRESET_TURBO" } }),
        "utf8"
      );
      const desktopCfg = loadAntigravityConfig({
        SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
        SEA_BRIDGE_ANTIGRAVITY_GEMINI_DIR: tmp,
      });
      expect(desktopCfg.approvalPolicy).toBe("auto");

      const askCfg = loadAntigravityConfig({
        SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
        SEA_BRIDGE_ANTIGRAVITY_GEMINI_DIR: tmp,
        SEA_BRIDGE_ANTIGRAVITY_APPROVAL_POLICY: "ask",
      });
      expect(askCfg.approvalPolicy).toBe("ask");

      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const approvalBridge = new AntigravityApprovalBridge(store);
      const capabilityGate = new AntigravityCapabilityGate({ enabled: true, writeEnabled: true, desktopReadEnabled: true });
      const modelCatalog = new AntigravityModelCatalog({
        cliPath: "/Users/zhuhaijun/.local/bin/agy",
        runner: async () => modelsFixture,
      });

      let currentCallbacks!: AcpClientCallbacks;
      let currentGeneration = 0;
      let resolvePrompt!: (value: { stopReason: string }) => void;

      const manager = new AntigravitySessionManager({
        store,
        approvalBridge,
        capabilityGate,
        modelCatalog,
        cliPath: "/bin/echo",
        approvalPolicy: "auto",
        getAllowedProjects: () => [{ id: "proj-1", name: "SeaBridge", rootPath: "/opt/app/aitools/sea-bridge" }],
        clientFactory: (generation, _cwd, callbacks) => {
          currentGeneration = generation;
          currentCallbacks = callbacks;
          return {
            start() {},
            identity: () => ({ pid: 3000 + generation, startedAt: Date.now(), generation, closed: false }),
            initialize: async () => ({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
            }),
            sessionNew: async () => ({ sessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85" }),
            prompt: () => ({
              rpcRequestId: "1",
              promise: new Promise((resolve) => {
                resolvePrompt = resolve;
              }),
            }),
            close: () => {},
          } as unknown as AcpClient;
        },
      });

      const createRes = await manager.create({
        operationId: "op-turbo-1",
        projectId: "proj-1",
        modelId: null,
        prompt: "Run checks",
        onSessionKnown: () => {},
      });
      expect(createRes.state).toBe("queued");

      const permRes = await currentCallbacks.onPermissionRequest!(
        99,
        {
          sessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85",
          toolCall: { toolCallId: "tc-1", name: "run_command", title: "ls -la" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        currentGeneration
      );
      expect(permRes).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(store.listPendingApprovals("9d3547fd-5f23-4178-b143-38a82ad31d85")).toHaveLength(0);

      resolvePrompt({ stopReason: "end_turn" });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("waits for active turns during graceful shutdown and records a system error message when a turn fails without assistant text", async () => {
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

      let resolvePrompt!: (value: { stopReason: string }) => void;
      let rejectPrompt!: (reason?: unknown) => void;
      let currentCallbacks!: AcpClientCallbacks;
      let currentGeneration = 0;

      const manager = new AntigravitySessionManager({
        store,
        approvalBridge,
        capabilityGate,
        modelCatalog,
        cliPath: "/bin/echo",
        getAllowedProjects: () => [{ id: "proj-1", name: "SeaBridge", rootPath: "/opt/app/aitools/sea-bridge" }],
        clientFactory: (generation, _cwd, callbacks) => {
          currentGeneration = generation;
          currentCallbacks = callbacks;
          return {
            start() {},
            identity: () => ({ pid: 4000 + generation, startedAt: Date.now(), generation, closed: false }),
            initialize: async () => ({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
            }),
            sessionNew: async () => ({ sessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85" }),
            sessionResume: async (sessionId: string) => ({ sessionId }),
            prompt: () => ({
              rpcRequestId: "1",
              promise: new Promise((resolve, reject) => {
                resolvePrompt = resolve;
                rejectPrompt = reject;
              }),
            }),
            close: () => {
              rejectPrompt?.(new Error("acp_transport_closed"));
            },
          } as unknown as AcpClient;
        },
      });

      const sessionId = "9d3547fd-5f23-4178-b143-38a82ad31d85";
      const createRes = await manager.create({
        operationId: "op-grace-1",
        projectId: "proj-1",
        modelId: null,
        prompt: "Deploy and reply",
        onSessionKnown: () => {},
      });
      expect(createRes.state).toBe("queued");
      expect(manager.hasActiveTurn(sessionId)).toBe(true);

      // Finish turn 80ms after shutdown starts; graceful shutdown (500ms) waits for completion instead of aborting
      setTimeout(() => {
        currentCallbacks.onSessionUpdate?.(
          {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Completed before shutdown deadline" } },
          },
          currentGeneration
        );
        resolvePrompt({ stopReason: "end_turn" });
      }, 80);

      await manager.shutdown(500);
      expect(manager.hasActiveTurn(sessionId)).toBe(false);
      expect(store.getExecution(createRes.turnId!)?.status).toBe("completed");
      expect(store.getSession(sessionId)?.status).toBe("idle");

      // Next turn fails mid-tool with acp_transport_closed and no assistant text -> records system error message
      const sendRes = await manager.send(sessionId, "op-fail-1", "Run tool only");
      expect(sendRes.state).toBe("queued");
      currentCallbacks.onSessionUpdate?.(
        {
          sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "tc-deploy", name: "run_command", title: "Deploy service", status: "in_progress" },
        },
        currentGeneration
      );
      rejectPrompt(new Error("acp_transport_closed"));
      await new Promise((r) => setTimeout(r, 15));

      expect(store.getSession(sessionId)?.status).toBe("unknown");
      const messages = store.listMessages(sessionId);
      const sysErr = messages.find((m) => m.role === "system" && m.kind === "error");
      expect(sysErr?.text).toContain("acp_transport_closed");
    } finally {
      db.close();
    }
  });
});

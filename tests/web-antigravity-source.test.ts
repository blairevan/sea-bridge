import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import type { AcpClient } from "../src/antigravity/client.ts";
import { loadAntigravityConfig } from "../src/antigravity/config.ts";
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

const modelsFixture = readFileSync(path.join(import.meta.dir, "fixtures", "antigravity-acp", "agy-models.txt"), "utf8");

describe("AntigravityWebSource and Web HTTP integration", () => {
  test("deduplicates managed (sea_bridge) and desktop read-only sessions, supports model+effort selection, web approval, and exact interrupt over HTTP", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "web-agy-source-"));
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      migrateWeb(db);

      // Prepare a desktop conversation_summaries.db with 2 sessions:
      // 1 shared ID (managed overrides desktop) and 1 desktop-only ID
      const sharedId = "9d3547fd-5f23-4178-b143-38a82ad31d85";
      const desktopOnlyId = "11111111-2222-3333-4444-555555555555";
      const desktopDbPath = path.join(root, "conversation_summaries.db");
      const desktopDb = new Database(desktopDbPath, { create: true });
      desktopDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          step_count INTEGER NOT NULL DEFAULT 0,
          last_modified_time DATETIME NOT NULL,
          workspace_uris TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '',
          parent_conversation_id TEXT NOT NULL DEFAULT '',
          nesting_depth INTEGER NOT NULL DEFAULT 0,
          not_fully_idle NUMERIC NOT NULL DEFAULT 0,
          killed NUMERIC NOT NULL DEFAULT 0
        );
      `);
      const ins = desktopDb.query(
        "INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,'',0,0,0)"
      );
      ins.run(sharedId, "Desktop Copy Title", "", 2, "2026-11-09T01:00:00Z", "[]", "CASCADE_RUN_STATUS_IDLE");
      ins.run(desktopOnlyId, "Pure Desktop Session", "", 5, "2026-11-09T02:00:00Z", "[]", "CASCADE_RUN_STATUS_IDLE");
      desktopDb.close();

      const projDir = path.join(root, "workspace");
      mkdirSync(projDir, { recursive: true });

      const config = loadAntigravityConfig({
        SEA_BRIDGE_ANTIGRAVITY_ENABLED: "true",
        SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED: "true",
        SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED: "true",
        SEA_BRIDGE_ANTIGRAVITY_DESKTOP_APP_DATA_DIR: root,
        SEA_BRIDGE_ANTIGRAVITY_PROJECTS_JSON: JSON.stringify([
          { id: "proj-1", name: "SeaBridge", rootPath: projDir },
        ]),
      });

      const store = new AntigravityStore(db);
      for (const p of config.allowedProjects) {
        store.upsertProject({ id: p.id, name: p.name, rootPath: p.rootPath, policyVersion: "v1", updatedAt: 100 });
      }
      const webStore = new WebStore(db);
      const capabilityGate = new AntigravityCapabilityGate({
        enabled: true,
        writeEnabled: true,
        desktopReadEnabled: true,
      });
      const modelCatalog = new AntigravityModelCatalog({
        cliPath: "/Users/zhuhaijun/.local/bin/agy",
        runner: async () => modelsFixture,
      });
      const approvalBridge = new AntigravityApprovalBridge(store);
      const desktopReader = new AntigravityDesktopReader({
        desktopAppDataDir: root,
        getAllowedProjects: () => store.listProjects(),
      });

      let resolvePrompt!: (v: { stopReason: string }) => void;
      const sessionManager = new AntigravitySessionManager({
        store,
        webStore,
        approvalBridge,
        capabilityGate,
        modelCatalog,
        cliPath: "/bin/echo",
        getAllowedProjects: () => store.listProjects(),
        clientFactory: (generation) =>
          ({
            start() {},
            identity: () => ({ pid: 2000 + generation, startedAt: Date.now(), generation, closed: false }),
            initialize: async () => ({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
            }),
            sessionNew: async () => ({
              sessionId: sharedId,
              configOptions: [
                { id: "model", name: "Model", type: "select", currentValue: "gemini-4-argon", options: [] },
                { id: "thought_level", name: "Thinking Level", type: "select", currentValue: "medium", options: [] },
              ],
            }),
            setConfigOption: async (_sid: string, configId: string, value: string) => ({
              configOptions: [
                { id: "model", name: "Model", type: "select", currentValue: configId === "model" ? value : "gemini-3.8-flash", options: [] },
                { id: "thought_level", name: "Thinking Level", type: "select", currentValue: configId === "thought_level" ? value : "low", options: [] },
              ],
            }),
            prompt: () => ({
              rpcRequestId: "1",
              promise: new Promise((resolve) => {
                resolvePrompt = resolve;
              }),
            }),
            cancel: async () => {
              resolvePrompt({ stopReason: "cancelled" });
            },
            close() {},
          }) as unknown as AcpClient,
      });

      const agySource = new AntigravityWebSource({
        config,
        store,
        webStore,
        capabilityGate,
        modelCatalog,
        desktopReader,
        approvalBridge,
        sessionManager,
      });

      const auth = new WebAuth(webStore);
      const events = new WebEvents(webStore);
      const paired = await loginFixture(auth);
      if (!paired) throw new Error("login fixture failed");
      const cookie = `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}`;

      const handler = createWebHandler({
        store: webStore,
        auth,
        events,
        sources: { antigravity: agySource },
        pepper: randomBytes(32),
        redaction: new WebRedaction([]),
        port: 7310,
        remoteOrigin: null,
        telegramStatus: () => ({ stopped: false, lastPollSuccessAt: null, pollFailed: false }),
      });

      const req = (urlPath: string, method = "GET", body?: unknown) =>
        handler(
          new Request("http://127.0.0.1:7310" + urlPath, {
            method,
            headers: {
              Origin: "http://127.0.0.1:7310",
              Cookie: cookie,
              "X-Sea-Bridge-CSRF": paired.csrfToken,
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }),
          "127.0.0.1"
        );

      // 1. Models endpoint returns family-aggregated models with supportedReasoningEfforts
      const modelsRes = await req("/api/sources/antigravity/models");
      expect(modelsRes.status).toBe(200);
      const modelsData = (await modelsRes.json()).data.items;
      expect(modelsData).toHaveLength(5);
      expect(modelsData[0]).toEqual({
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"],
      });

      // 2. Create session via POST /api/sessions with separated modelId + reasoningEffort
      const createOpId = randomUUID();
      const createRes = await req("/api/sessions", "POST", {
        operationId: createOpId,
        source: "antigravity",
        projectId: "proj-1",
        modelId: "gemini-3.8-flash",
        reasoningEffort: "low",
        prompt: "Managed session title",
      });
      expect(createRes.status).toBe(200);
      const createJson = (await createRes.json()).data;
      expect(createJson.sessionId).toBe(sharedId);
      expect(createJson.state).toBe("queued");

      // 3. List sessions deduplicates sharedId (managed sea_bridge wins over desktop) and includes desktopOnlyId
      const listRes = await req("/api/sessions?source=antigravity");
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()).data.items;
      expect(listed).toHaveLength(2);
      const managedItem = listed.find((i: any) => i.id === sharedId);
      const desktopItem = listed.find((i: any) => i.id === desktopOnlyId);
      expect(managedItem.creationClient.kind).toBe("sea_bridge");
      expect(managedItem.title).toBe("Managed session title");
      expect(managedItem.sessionMeta).toEqual({
        model: { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
        reasoningEffort: "low",
      });
      expect(desktopItem.creationClient.kind).toBe("desktop");
      expect(desktopItem.sendEnabled).toBe(false);

      // Filter by creationClient=desktop
      const desktopOnlyList = await req("/api/sessions?source=antigravity&creationClient=desktop");
      expect((await desktopOnlyList.json()).data.items.map((i: any) => i.id)).toEqual([desktopOnlyId]);

      // 4. Trigger a pending permission request and approve it via POST /api/sessions/antigravity/:id/approvals/:approvalId
      const { approval, promise: permPromise } = approvalBridge.requestPermission({
        sessionId: sharedId,
        executionId: createJson.turnId,
        processGeneration: 1,
        rpcRequestId: "perm-1",
        request: {
          sessionId: sharedId,
          toolCall: { toolCallId: "tc-1", name: "run_command", title: "echo hello" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      const histDuringPerm = (await (await req(`/api/sessions/antigravity/${sharedId}/history`)).json()).data;
      expect(histDuringPerm.pendingApprovals).toHaveLength(1);
      expect(histDuringPerm.pendingApprovals[0].id).toBe(approval.id);

      const approveRes = await req(
        `/api/sessions/antigravity/${sharedId}/approvals/${approval.id}`,
        "POST",
        { optionId: "allow" }
      );
      expect(approveRes.status).toBe(200);
      expect((await approveRes.json()).data).toEqual({ status: "decided", optionId: "allow" });
      expect(await permPromise).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

      // 5. Interrupt active execution via POST /api/sessions/antigravity/:id/interrupt
      const interruptRes = await req(`/api/sessions/antigravity/${sharedId}/interrupt`, "POST", {
        expectedExecutionId: createJson.turnId,
        expectedEpoch: 1,
      });
      expect(interruptRes.status).toBe(200);
      expect((await interruptRes.json()).data).toEqual({ status: "interrupting" });
      await new Promise((r) => setTimeout(r, 10));

      // 6. Idle model + reasoningEffort update via POST /api/sessions/antigravity/:id/model
      const updateModelRes = await req(`/api/sessions/antigravity/${sharedId}/model`, "POST", {
        modelId: "claude-sonnet-5-5",
        reasoningEffort: "high",
      });
      expect(updateModelRes.status).toBe(200);
      expect((await updateModelRes.json()).data).toEqual({
        status: "updated",
        model: { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
        reasoningEffort: "high",
      });

      // Desktop read-only session rejects model update with 409
      const desktopModelRes = await req(`/api/sessions/antigravity/${desktopOnlyId}/model`, "POST", {
        modelId: "claude-sonnet-5-5",
      });
      expect(desktopModelRes.status).toBe(409);

      // 7. Operations endpoint resolves Antigravity session title
      const opsRes = await req("/api/operations?source=antigravity");
      expect(opsRes.status).toBe(200);
      const opsItems = (await opsRes.json()).data.items;
      expect(opsItems[0]?.sessionTitle).toBe("Managed session title");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

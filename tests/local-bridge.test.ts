import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import type { WebSource } from "../src/web/sources/types.ts";
import { LOGIN_FIXTURE, LOGIN_HASH } from "./helpers/web-login.ts";
import { LocalBridgeService } from "../src/bridge/service.ts";
import { LocalBridgeServer } from "../src/bridge/server.ts";

/** Send a JSON HTTP request over a private Unix Domain Socket. */
async function unixJson(
  socketPath: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://sea-bridge.local${path}`, {
    ...init,
    unix: socketPath,
  } as RequestInit & { unix: string });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

describe("LocalBridgeServer & LocalBridgeService (bridge.sock)", () => {
  test("enforces 0700/0600 permissions, blocks browser headers, and delegates auth + multi-source native sessions", async () => {
    const dir = mkdtempSync("/tmp/sb-lb-");
    const socketPath = join(dir, "run", "bridge.sock");
    const db = new Database(":memory:");
    migrateWeb(db);
    const store = new WebStore(db);
    const auth = new WebAuth(store);
    const events = new WebEvents(store);
    const redaction = new WebRedaction(["secret-token-xyz"]);

    let codexDesktopOpened = 0;
    const interrupted: {
      codex: string | null;
      ag: { id: string; executionId: string; epoch: number } | null;
    } = { codex: null, ag: null };
    const sentPrompts: Array<{ source: string; id: string; prompt: string }> = [];

    const codexSource: WebSource = {
      capabilities: () => ({
        sessionsReadable: true,
        projectsReadable: true,
        modelsReadable: true,
        historyReadable: true,
        completeUserHistoryReadable: false,
        finalReplyReadable: true,
        createEnabled: true,
        sendEnabled: true,
        desktopOpenEnabled: true,
        approvalTransport: "telegram",
      }),
      async projects() {
        return [{ id: "proj-toolhub", name: "toolhub" }];
      },
      async models() {
        return [{ id: "gpt-5.4", name: "GPT-5.4", defaultReasoningEffort: "high", supportedReasoningEfforts: ["medium", "high"] }];
      },
      async sessions() {
        return [{
          source: "codex",
          id: "codex-s1",
          title: "Fix login gate",
          updatedAt: 1700000000000,
          projectId: "proj-toolhub",
          state: "idle",
          sendEnabled: true,
        }];
      },
      async history(id) {
        if (id !== "codex-s1") throw new Error("session_missing");
        return {
          messages: [
            { id: "u-1", role: "user", text: "Fix login" },
            { id: "a-1", role: "assistant", text: "Completed login gate with secret-token-xyz scrubbed." },
          ],
          cursor: null,
          completeUserHistory: false,
          sessionState: "idle",
          turnControl: { activeTurnId: "turn-99", interrupt: { status: "available", scope: "exact_codex_turn" } },
        };
      },
      async execution() {
        return { state: "session_ended", exact: true };
      },
      async create(input) {
        input.onSessionKnown("codex-s1");
        return { state: "accepted", sessionId: "codex-s1", turnId: "turn-1" };
      },
      async send(id, _opId, prompt) {
        sentPrompts.push({ source: "codex", id, prompt });
        return { state: "accepted", sessionId: id, turnId: "turn-2" };
      },
      async interrupt(_id, expectedTurnId) {
        interrupted.codex = expectedTurnId;
        return { status: "interrupting" };
      },
      async openDesktop() {
        codexDesktopOpened++;
      },
    };

    const antigravitySource: WebSource = {
      capabilities: () => ({
        sessionsReadable: true,
        projectsReadable: true,
        modelsReadable: true,
        historyReadable: true,
        completeUserHistoryReadable: true,
        finalReplyReadable: true,
        createEnabled: true,
        sendEnabled: true,
        approvalTransport: "web_and_telegram",
      }),
      async projects() {
        return [{ id: "ag-proj-1", name: "sea-bridge" }];
      },
      async models() {
        return [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }];
      },
      async sessions() {
        return [{
          source: "antigravity",
          id: "ag-s1",
          title: "Antigravity session",
          updatedAt: 1700000005000,
          projectId: "ag-proj-1",
          state: "running",
          sendEnabled: false,
        }];
      },
      async history(id) {
        if (id !== "ag-s1") throw new Error("session_missing");
        return {
          messages: [{ id: "ag-u1", role: "user", text: "Run task" }],
          cursor: null,
          completeUserHistory: true,
          sessionState: "running",
          executionControl: {
            activeExecutionId: "exec-7",
            activeEpoch: 3,
            interrupt: { status: "available", scope: "exact_antigravity_execution" },
          },
          pendingApprovals: [],
        };
      },
      async create(input) {
        input.onSessionKnown("ag-s1");
        return { state: "accepted", sessionId: "ag-s1" };
      },
      async send(id, _opId, prompt) {
        sentPrompts.push({ source: "antigravity", id, prompt });
        return { state: "accepted", sessionId: id };
      },
      async interruptExecution(id, expectedExecutionId, expectedEpoch) {
        interrupted.ag = { id, executionId: expectedExecutionId, epoch: expectedEpoch };
        return { status: "interrupting" };
      },
    };

    const dshSource: WebSource = {
      capabilities: () => ({
        sessionsReadable: true,
        projectsReadable: true,
        modelsReadable: true,
        historyReadable: true,
        completeUserHistoryReadable: false,
        finalReplyReadable: true,
        createEnabled: true,
        sendEnabled: true,
        approvalTransport: null,
      }),
      async projects() {
        return [{ id: "dsh-proj", name: "dsh-workspace" }];
      },
      async models() {
        return [{ id: "dsh-model", name: "Claude Sonnet" }];
      },
      async sessions() {
        return [{
          source: "dsh",
          id: "dsh-s1",
          title: "DSH work",
          updatedAt: 1700000010000,
          projectId: null,
          state: "unknown",
          sendEnabled: true,
        }];
      },
      async history(id) {
        if (id !== "dsh-s1") throw new Error("session_missing");
        return {
          messages: [{ id: "dsh-a1", role: "assistant", text: "DSH finished reply" }],
          cursor: null,
          completeUserHistory: false,
        };
      },
      async create(input) {
        input.onSessionKnown("dsh-s1");
        return { state: "accepted", sessionId: "dsh-s1" };
      },
      async send(id, _opId, prompt) {
        sentPrompts.push({ source: "dsh", id, prompt });
        return { state: "accepted", sessionId: id };
      },
    };

    const service = new LocalBridgeService({
      store,
      auth,
      events,
      redaction,
      pepper: randomBytes(32),
      sources: { codex: codexSource, antigravity: antigravitySource, dsh: dshSource },
      webBaseUrl: "https://code.xxone.xyz",
    });
    const server = new LocalBridgeServer(socketPath, service);
    await server.start();

    try {
      // 1. Socket & parent directory permissions
      expect(lstatSync(join(dir, "run")).mode & 0o777).toBe(0o700);
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);

      // 2. Reject browser headers
      const blockedOrigin = await unixJson(socketPath, "/v1/health", {
        headers: { Origin: "https://evil.example" },
      });
      expect(blockedOrigin.status).toBe(403);
      expect(blockedOrigin.body.errorCode).toBe("browser_not_allowed");

      const blockedFetchSite = await unixJson(socketPath, "/v1/health", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(blockedFetchSite.status).toBe(403);

      // 3. Health before account setup
      const healthBefore = await unixJson(socketPath, "/v1/health");
      expect(healthBefore.status).toBe(200);
      expect(healthBefore.body.ready).toBe(true);
      expect(healthBefore.body.accountConfigured).toBe(false);

      // Login before account setup -> 503
      const noAccountLogin = await unixJson(socketPath, "/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: LOGIN_FIXTURE.username,
          password: LOGIN_FIXTURE.password,
          bucket: "remote",
          deviceName: "macOS · Chrome",
          loginIp: "198.51.100.25",
          clientApp: "toolhub",
        }),
      });
      expect(noAccountLogin.status).toBe(503);

      // Configure admin account
      auth.setAccount(LOGIN_FIXTURE.username, LOGIN_HASH);

      // Login with valid credentials
      const loginOk = await unixJson(socketPath, "/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: LOGIN_FIXTURE.username,
          password: LOGIN_FIXTURE.password,
          bucket: "remote",
          deviceName: "macOS · Chrome",
          loginIp: "198.51.100.25",
          clientApp: "toolhub",
        }),
      });
      expect(loginOk.status).toBe(200);
      const sessionToken = String(loginOk.body.sessionToken);
      const csrfToken = String(loginOk.body.csrfToken);
      const device = loginOk.body.device as { id: string; name: string; loginIp: string; clientApp: string };
      expect(sessionToken.length).toBe(43);
      expect(csrfToken.length).toBe(43);
      expect(device.clientApp).toBe("toolhub");
      expect(device.loginIp).toBe("198.51.100.25");

      // Verify read & write CSRF
      const verifyRead = await unixJson(socketPath, "/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, requireCsrf: false }),
      });
      expect(verifyRead.body.authenticated).toBe(true);
      expect(verifyRead.body.csrfValid).toBe(true);

      const verifyBadCsrf = await unixJson(socketPath, "/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, csrfCookie: csrfToken, csrfHeader: "wrong", requireCsrf: true }),
      });
      expect(verifyBadCsrf.body.authenticated).toBe(true);
      expect(verifyBadCsrf.body.csrfValid).toBe(false);

      const verifyGoodCsrf = await unixJson(socketPath, "/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, csrfCookie: csrfToken, csrfHeader: csrfToken, requireCsrf: true }),
      });
      expect(verifyGoodCsrf.body.authenticated).toBe(true);
      expect(verifyGoodCsrf.body.csrfValid).toBe(true);

      // 4. Multi-source catalog
      const catalog = await unixJson(socketPath, "/v1/catalog");
      expect(catalog.status).toBe(200);
      expect(catalog.body.webBaseUrl).toBe("https://code.xxone.xyz");
      const sources = catalog.body.sources as Array<{ source: string; projects: unknown[]; models: unknown[] }>;
      expect(sources.map((s) => s.source)).toEqual(["codex", "antigravity", "dsh"]);

      // 5. Create Codex session, query operation, summary, send rework, open desktop, interrupt
      const createOpId = randomUUID();
      const created = await unixJson(socketPath, "/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: createOpId,
          source: "codex",
          projectId: "proj-toolhub",
          modelId: "gpt-5.4",
          reasoningEffort: "high",
          prompt: "Implement feature X",
          deviceId: device.id,
        }),
      });
      expect(created.status).toBe(200);
      expect(created.body.sessionId).toBe("codex-s1");
      expect(created.body.state).toBe("accepted");

      const opRes = await unixJson(socketPath, `/v1/operations/${createOpId}`);
      expect(opRes.status).toBe(200);
      expect((opRes.body.operation as { sessionId: string }).sessionId).toBe("codex-s1");

      const codexSummary = await unixJson(socketPath, "/v1/sessions/codex/codex-s1/summary");
      expect(codexSummary.status).toBe(200);
      expect(codexSummary.body.exists).toBe(true);
      expect(codexSummary.body.state).toBe("idle");
      expect(codexSummary.body.lastAssistantId).toBe("a-1");
      expect(String(codexSummary.body.lastAssistantText)).not.toContain("secret-token-xyz");
      expect(codexSummary.body.canOpenDesktop).toBe(true);

      const dshSummary = await unixJson(socketPath, "/v1/sessions/dsh/dsh-s1/summary");
      expect(dshSummary.body.exists).toBe(true);
      expect(dshSummary.body.state).toBe("unknown");
      expect(dshSummary.body.lastAssistantId).toBe("dsh-a1");

      const sendRes = await unixJson(socketPath, "/v1/sessions/codex/codex-s1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: randomUUID(),
          prompt: "Please refine error message",
          deviceId: device.id,
        }),
      });
      expect(sendRes.status).toBe(200);
      expect(sentPrompts).toEqual([{ source: "codex", id: "codex-s1", prompt: "Please refine error message" }]);

      const openDesktop = await unixJson(socketPath, "/v1/sessions/codex/codex-s1/open-desktop", { method: "POST" });
      expect(openDesktop.status).toBe(200);
      expect(codexDesktopOpened).toBe(1);

      const intCodex = await unixJson(socketPath, "/v1/sessions/codex/codex-s1/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedTurnId: "turn-99", deviceId: device.id }),
      });
      expect(intCodex.status).toBe(200);
      expect(interrupted.codex).toBe("turn-99");

      const intAg = await unixJson(socketPath, "/v1/sessions/antigravity/ag-s1/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedExecutionId: "exec-7", expectedEpoch: 3, deviceId: device.id }),
      });
      expect(intAg.status).toBe(200);
      expect(interrupted.ag).toEqual({ id: "ag-s1", executionId: "exec-7", epoch: 3 });

      // 6. Logout revokes device immediately
      const logoutRes = await unixJson(socketPath, "/v1/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: device.id }),
      });
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.revoked).toBe(true);

      const verifyAfterLogout = await unixJson(socketPath, "/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, requireCsrf: false }),
      });
      expect(verifyAfterLogout.body.authenticated).toBe(false);
    } finally {
      await server.stop();
      events.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

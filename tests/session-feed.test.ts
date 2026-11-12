import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import type { SessionListOptions, WebSource } from "../src/web/sources/types.ts";
import { LocalBridgeService } from "../src/bridge/service.ts";
import { LocalBridgeServer } from "../src/bridge/server.ts";
import { parseSessionFeedQuery, resolveWorkspaceProject } from "../src/bridge/session-feed.ts";

/** Issue an HTTP JSON call against a private Unix Domain Socket. */
async function unixJson(
  socketPath: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://sea-bridge.local${path}`, {
    unix: socketPath,
  } as RequestInit & { unix: string });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe("resolveWorkspaceProject & GET /v1/sessions", () => {
  test("resolves registered projectId, longest boundary-safe cwd prefix, and hashed unregistered fallback", () => {
    const projects = [
      { id: "proj-root", name: "aitools", roots: ["/workspace/aitools"] },
      { id: "proj-toolhub", name: "toolhub", roots: ["/workspace/aitools/toolhub"] },
    ];

    const byExplicit = resolveWorkspaceProject({
      explicitProjectId: "proj-root",
      cwd: "/workspace/aitools/toolhub",
      projects,
      createdAtMs: 1700000001000,
    });
    expect(byExplicit).toEqual({
      projectId: "proj-root",
      projectName: "aitools",
      createdAtMs: 1700000001000,
    });

    const byLongestPrefix = resolveWorkspaceProject({
      explicitProjectId: null,
      cwd: "/workspace/aitools/toolhub/src/tasks",
      projects,
      createdAtMs: 1700000002000,
    });
    expect(byLongestPrefix).toEqual({
      projectId: "proj-toolhub",
      projectName: "toolhub",
      createdAtMs: 1700000002000,
    });

    // Ensure sibling prefix `/workspace/aitools-extra` does not falsely match `/workspace/aitools`
    const unregistered = resolveWorkspaceProject({
      explicitProjectId: null,
      cwd: "/workspace/aitools-extra/demo-app",
      projects,
      createdAtMs: null,
    });
    expect(unregistered.projectId).toMatch(/^dir:demo-app-[0-9a-f]{8}$/);
    expect(unregistered.projectName).toBe("demo-app");
    expect(unregistered.projectId).not.toContain("/workspace");
  });

  test("validates sinceMs and limit query bounds", () => {
    expect(parseSessionFeedQuery(new URLSearchParams())).toEqual({ sinceMs: 0, limit: 100 });
    expect(parseSessionFeedQuery(new URLSearchParams("sinceMs=1700000000000&limit=50"))).toEqual({
      sinceMs: 1700000000000,
      limit: 50,
    });
    expect(() => parseSessionFeedQuery(new URLSearchParams("sinceMs=-5"))).toThrow();
    expect(() => parseSessionFeedQuery(new URLSearchParams("limit=0"))).toThrow();
    expect(() => parseSessionFeedQuery(new URLSearchParams("limit=201"))).toThrow();
    expect(() => parseSessionFeedQuery(new URLSearchParams("sinceMs=abc"))).toThrow();
  });

  test("serves two-phase filtered codex & antigravity feed over bridge.sock while excluding exec and dsh", async () => {
    const dir = mkdtempSync("/tmp/sb-feed-");
    const socketPath = join(dir, "run", "bridge.sock");
    const db = new Database(":memory:");
    migrateWeb(db);
    const store = new WebStore(db);
    const auth = new WebAuth(store);
    const events = new WebEvents(store);
    const redaction = new WebRedaction(["top-secret-xyz"]);

    const codexCalls: SessionListOptions[] = [];
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
        approvalTransport: "telegram",
      }),
      async projects() {
        return [{ id: "proj-toolhub", name: "toolhub" }];
      },
      async models() {
        return [];
      },
      async sessions(options = {}) {
        codexCalls.push(options);
        const base = [
          {
            source: "codex" as const,
            id: "codex-cli-recent",
            title: "CLI task top-secret-xyz",
            updatedAt: 2_000_000,
            projectId: null,
            creationClient: { kind: "cli" as const, evidence: "explicit" as const },
            sessionMeta: { model: { id: "gpt-5.4" }, reasoningEffort: "high" },
            // Phase 1 (`limit: 0`) sees unknown; Phase 2 (`sessionIds`) resolves idle
            state: options.sessionIds ? ("idle" as const) : ("unknown" as const),
            sendEnabled: true,
          },
          {
            source: "codex" as const,
            id: "codex-old-idle",
            title: "Historical thread",
            updatedAt: 500_000,
            projectId: null,
            creationClient: { kind: "desktop" as const, evidence: "explicit" as const },
            state: "idle" as const,
            sendEnabled: true,
          },
          {
            source: "codex" as const,
            id: "codex-old-running",
            title: "Long running desktop task",
            updatedAt: 400_000,
            projectId: null,
            creationClient: { kind: "desktop" as const, evidence: "explicit" as const },
            state: "running" as const,
            sendEnabled: true,
          },
          {
            source: "codex" as const,
            id: "codex-exec-job",
            title: "Automated exec run",
            updatedAt: 2_500_000,
            projectId: null,
            creationClient: { kind: "exec" as const, evidence: "explicit" as const },
            state: "idle" as const,
            sendEnabled: false,
          },
        ];
        if (options.sessionIds) {
          return base.filter((s) => options.sessionIds?.includes(s.id));
        }
        return base;
      },
      async bridgeWorkspaces(ids) {
        const map = new Map();
        for (const id of ids) {
          map.set(id, { projectId: "proj-toolhub", projectName: "toolhub", createdAtMs: 1_900_000 });
        }
        return map;
      },
      async history() {
        throw new Error("unused");
      },
      async create() {
        throw new Error("unused");
      },
      async send() {
        throw new Error("unused");
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
        return [{ id: "proj-sb", name: "sea-bridge" }];
      },
      async models() {
        return [];
      },
      async sessions() {
        return [
          {
            source: "antigravity" as const,
            id: "ag-waiting-input",
            title: "Antigravity Desktop question",
            updatedAt: 1_800_000,
            projectId: "proj-sb",
            creationClient: { kind: "desktop" as const, evidence: "explicit" as const },
            sessionMeta: { model: { id: "gemini-3.1-pro" }, reasoningEffort: "medium" },
            state: "waiting_user_input" as const,
            sendEnabled: true,
          },
          {
            source: "antigravity" as const,
            id: "ag-sea-bridge",
            title: "Sea-Bridge Web session",
            updatedAt: 1_750_000,
            projectId: "proj-sb",
            creationClient: { kind: "sea_bridge" as const, evidence: "explicit" as const },
            state: "idle" as const,
            sendEnabled: true,
          },
        ];
      },
      async history() {
        throw new Error("unused");
      },
      async create() {
        throw new Error("unused");
      },
      async send() {
        throw new Error("unused");
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
        return [];
      },
      async models() {
        return [];
      },
      async sessions() {
        return [
          {
            source: "dsh" as const,
            id: "dsh-recent",
            title: "Should never sync automatically",
            updatedAt: 3_000_000,
            projectId: null,
            state: "running" as const,
            sendEnabled: true,
          },
        ];
      },
      async history() {
        throw new Error("unused");
      },
      async create() {
        throw new Error("unused");
      },
      async send() {
        throw new Error("unused");
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
      const badQuery = await unixJson(socketPath, "/v1/sessions?limit=999");
      expect(badQuery.status).toBe(400);
      expect(badQuery.body.errorCode).toBe("invalid_query");

      const ok = await unixJson(socketPath, "/v1/sessions?sinceMs=1000000&limit=50");
      expect(ok.status).toBe(200);
      expect(ok.body.partial).toBe(false);

      const items = ok.body.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.sessionId)).toEqual([
        "codex-cli-recent",
        "ag-waiting-input",
        "ag-sea-bridge",
        "codex-old-running",
      ]);

      // Two-phase check: first scan used limit: 0, second refreshed only matched IDs
      expect(codexCalls[0]).toEqual({ limit: 0 });
      expect(codexCalls[1]?.sessionIds).toEqual(["codex-cli-recent", "codex-old-running"]);

      const cliItem = items[0]!;
      expect(cliItem.clientTarget).toBe("cli");
      expect(cliItem.state).toBe("idle");
      expect(cliItem.projectId).toBe("proj-toolhub");
      expect(cliItem.createdAtMs).toBe(1_900_000);
      expect(String(cliItem.title)).not.toContain("top-secret-xyz");

      const waitingItem = items[1]!;
      expect(waitingItem.clientTarget).toBe("desktop");
      expect(waitingItem.state).toBe("waiting_external_approval");

      const seaBridgeItem = items[2]!;
      expect(seaBridgeItem.clientTarget).toBeNull();
    } finally {
      await server.stop();
      events.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

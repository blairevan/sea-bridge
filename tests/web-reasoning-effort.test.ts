import { LOGIN_FIXTURE, LOGIN_HASH, loginFixture } from "./helpers/web-login.ts";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import { WebEvents } from "../src/web/events.ts";
import { createWebHandler } from "../src/web/http.ts";
import { CodexWebSource } from "../src/web/sources/codex.ts";
import type { WebSource, CreateRequest } from "../src/web/sources/types.ts";
import { runInNewContext } from "node:vm";

describe("Web Reasoning Effort API", () => {
  test("GET /api/sources/codex/models exposes reasoning effort metadata and POST /api/sessions forwards effort", async () => {
    const db = new Database(":memory:");
    migrateWeb(db);
    const store = new WebStore(db);
    const auth = new WebAuth(store);
    const events = new WebEvents(store);
    auth.setAccount(LOGIN_FIXTURE.username, LOGIN_HASH);
    const paired = await loginFixture(auth);
    if (!paired) throw new Error("fixture failed");
    const cookie = `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}`;

    let capturedCreate: CreateRequest | null = null;
    const source: WebSource = {
      capabilities: () => ({
        sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true,
        completeUserHistoryReadable: false, finalReplyReadable: true, createEnabled: true, sendEnabled: true,
        approvalTransport: null,
      }),
      async sessions() { return []; },
      async projects() { return [{ id: "p1", name: "Project 1" }]; },
      async models() {
        return [
          { id: "gpt-5.5", name: "GPT-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"] },
          { id: "gpt-4o", name: "GPT-4o" },
        ];
      },
      async history() { return { messages: [], cursor: null, completeUserHistory: false }; },
      async create(input) {
        capturedCreate = input;
        input.onSessionKnown("s1");
        return { state: "accepted", sessionId: "s1" };
      },
      async send() { throw new Error("unused"); },
    };

    const handler = createWebHandler({
      store, auth, events, sources: { codex: source }, pepper: randomBytes(32),
      redaction: new WebRedaction([]), port: 7311, remoteOrigin: null,
      telegramStatus: () => ({ stopped: false, lastPollSuccessAt: null, pollFailed: false }),
    });

    const request = (path: string, method = "GET", body?: unknown) => handler(new Request("http://127.0.0.1:7311" + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Origin: "http://127.0.0.1:7311",
        Cookie: cookie,
        "X-Sea-Bridge-CSRF": paired.csrfToken,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), "127.0.0.1");

    // 1. GET models returns reasoning metadata
    const modelsRes = await request("/api/sources/codex/models");
    expect(modelsRes.status).toBe(200);
    const modelsData = await modelsRes.json();
    expect(modelsData.data.items).toEqual([
      { id: "gpt-5.5", name: "GPT-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"] },
      { id: "gpt-4o", name: "GPT-4o" },
    ]);

    // 2. POST /api/sessions accepts reasoningEffort
    const createRes = await request("/api/sessions", "POST", {
      operationId: randomUUID(),
      source: "codex",
      projectId: "p1",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "test reasoning",
    });
    expect(createRes.status).toBe(200);
    expect(capturedCreate).toMatchObject({
      projectId: "p1",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "test reasoning",
    });

    // 3. POST /api/sessions rejects invalid reasoningEffort format
    const invalidRes = await request("/api/sessions", "POST", {
      operationId: randomUUID(),
      source: "codex",
      projectId: "p1",
      modelId: "gpt-5.5",
      reasoningEffort: "invalid effort with spaces!!!",
      prompt: "test reasoning",
    });
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json()).data).toEqual({ errorCode: "invalid_reasoning_effort" });
  });

  test("CodexWebSource.create validates reasoningEffort against model capabilities and forwards to startThreadAndTurn", async () => {
    let capturedActionParams: any = null;
    const codexSource = new CodexWebSource({
      threads: { listActive: () => [], getThread: () => null },
      catalogs: {
        async listProjects() { return [{ index: 1, id: "p1", name: "P1", roots: ["/repo"], primaryRoot: "/repo", position: 1 }]; },
        async listModels() {
          return [
            { id: "gpt-5.5", displayName: "GPT-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"] },
            { id: "gpt-4o", displayName: "GPT-4o" },
          ];
        },
      },
      actions: {
        async startThreadAndTurn(params) {
          capturedActionParams = params;
          params.onThreadStarted?.("thread-123");
          return { threadId: "thread-123", turnId: "turn-1", projectId: params.projectId, cwd: params.cwd, model: params.model ?? null };
        },
      },
      queue: { queue: async () => ({ status: "delivered", exitCode: 0 }) },
      sessionRoots: ["/repo"],
      pathExists: () => true,
      queueUsable: true,
      pendingApproval: () => false,
    });

    // 1. Success with valid reasoningEffort
    const successResult = await codexSource.create({
      operationId: randomUUID(),
      projectId: "p1",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "test",
      onSessionKnown: () => {},
    });
    expect(successResult.state).toBe("accepted");
    expect(capturedActionParams.reasoningEffort).toBe("high");

    // 2. Failure when model does not support the requested effort
    const unsupportedResult = await codexSource.create({
      operationId: randomUUID(),
      projectId: "p1",
      modelId: "gpt-4o",
      reasoningEffort: "high",
      prompt: "test",
      onSessionKnown: () => {},
    });
    expect(unsupportedResult).toEqual({
      state: "failed",
      sessionId: null,
      errorCode: "reasoning_effort_unavailable",
    });
  });

  test("syncReasoningEffortControl in app.js populates desktop efforts and disables unsupported models", async () => {
    const script = await Bun.file("src/web/public/app.js").text();
    const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
    class Fixture {
      children: any[] = [];
      value = "";
      disabled = false;
      textContent = "";
      constructor(public tag: string) {}
      get firstChild() { return this.children[0]; }
      append(...nodes: any[]) { this.children.push(...nodes); }
      replaceChildren(...nodes: any[]) { this.children = nodes; }
    }
    const nodes = new Map<string, Fixture>();
    const get = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, new Fixture("div"));
      return nodes.get(id)!;
    };
    const ui = runInNewContext(script.slice(0, end) + "\n({ syncReasoningEffortControl, setCreationModels: (m) => { creationModels = m; }, state })", {
      el: get,
      document: {
        getElementById: get,
        createElement: (tag: string) => new Fixture(tag),
        createTextNode: (text: string) => { const el = new Fixture("#text"); el.textContent = text; return el; },
      },
    }) as any;

    const modelSelect = get("create-model");
    const effortSelect = get("create-reasoning-effort");

    // 1. Model supporting low, medium, high, xhigh, max
    ui.state.paused = false;
    ui.setCreationModels({
      items: [
        { id: "gpt-5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-4o", supportedReasoningEfforts: [] },
      ],
    });
    modelSelect.value = "gpt-5.5";
    ui.syncReasoningEffortControl();

    expect(effortSelect.disabled).toBe(false);
    expect(effortSelect.children.map((o: any) => ({ value: o.value, text: o.textContent }))).toEqual([
      { value: "", text: "使用模型默认设置" },
      { value: "low", text: "低（轻度）" },
      { value: "medium", text: "中" },
      { value: "high", text: "高" },
    ]);

    // 2. Select medium, re-sync preserves selection
    effortSelect.value = "medium";
    ui.syncReasoningEffortControl();
    expect(effortSelect.value).toBe("medium");

    // 3. Switch to model without reasoning support
    modelSelect.value = "gpt-4o";
    ui.syncReasoningEffortControl();
    expect(effortSelect.disabled).toBe(true);
    expect(effortSelect.value).toBe("");
    expect(effortSelect.children.map((o: any) => ({ value: o.value, text: o.textContent }))).toEqual([
      { value: "", text: "使用模型默认设置" },
    ]);
  });
});


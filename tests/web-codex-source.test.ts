import { expect, test } from "bun:test";
import type { QueueResult } from "../src/desktop/codex-queue-client.ts";
import { CodexWebSource } from "../src/web/sources/codex.ts";
import type { CodexAppServerClient } from "../src/desktop/codex-app-server-client.ts";

test("Codex history exposes native queued messages separately from executed conversation", async () => {
  const fixture = "tests/fixtures/codex-rollout-web/visible.jsonl";
  const deps = {
    threads: { listActive: () => [], getThread: () => ({ id: "thread", title: "fixture", updatedAtMs: 1, rolloutPath: fixture }) },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn(): Promise<never> { throw new Error("unused"); } },
    queue: { async queue(): Promise<never> { throw new Error("unused"); } },
    sessionRoots: ["tests/fixtures/codex-rollout-web"], pathExists: () => true, queueUsable: true, pendingApproval: () => false,
    readQueue: () => ({ available: true, messages: [{ id: "queue-one", role: "user" as const, text: "waiting", createdAt: 10, deliveryState: "queued" as const }] }),
  };
  const source = new CodexWebSource(deps);
  expect(await source.history("thread", null, 30)).toMatchObject({ queuedMessages: [
    { id: "queue-one", text: "waiting", deliveryState: "queued" },
  ], queueUnavailable: false });
  expect((await source.history("thread", null, 30)).messages.some((message) => message.text === "waiting")).toBe(false);
});

test("Web Codex prompt is raw, catalog coalesces, ownership blocks queue until release", async () => {
  type Start = Parameters<CodexAppServerClient["startThreadAndTurn"]>[0];
  let release: Start["onOwnershipReleased"]; let prompt = ""; let queues = 0; let catalogs = 0; let approval = false;
  let activity: { state: "active" | "idle" | "unknown"; turnId: string | null } | null = null;
  let queueResult: QueueResult = { status: "delivered", exitCode: 0 };
  const source = new CodexWebSource({
    threads: { listActive: () => [{ id: "thread", title: "test", updatedAtMs: 1, rolloutPath: "/missing" }], getThread: () => ({ id: "thread", title: "test", updatedAtMs: 1, rolloutPath: "/missing" }) },
    appServer: {
      async listProjects() { catalogs++; return [{ id: "project", index: 1, name: "fixture", roots: ["/repo"], primaryRoot: "/repo", position: 1 }]; },
      async listModels() { return [{ id: "model", displayName: "fixture" }]; },
      async startThreadAndTurn(input) { prompt = input.prompt; release = input.onOwnershipReleased; input.onThreadStarted?.("thread"); return { threadId: "thread", turnId: "turn", projectId: input.projectId, cwd: input.cwd, model: null }; },
    },
    queue: { async queue() { queues++; return queueResult; } },
    sessionRoots: [], pathExists: () => true, queueUsable: true, pendingApproval: () => approval, activity: () => activity,
  });
  await Promise.all([source.projects(), source.projects()]); expect(catalogs).toBe(1);
  const result = await source.create({ operationId: "op", projectId: "project", modelId: null, prompt: "hello", onSessionKnown() {} });
  expect(prompt).toBe("hello"); expect(result.state).toBe("accepted");
  expect((await source.send("thread", "op2", "follow")).errorCode).toBe("first_turn_owned"); expect(queues).toBe(0);
  expect(await source.execution("thread", "turn")).toEqual({ state: "running", exact: false });
  expect(await source.execution("thread", "unrelated-turn")).toEqual({ state: "running", exact: false });
  release?.("thread", "turn");
  expect((await source.send("thread", "op3", "follow")).state).toBe("queued"); expect(queues).toBe(1);
  activity = { state: "active", turnId: "follow-turn" };
  expect((await source.sessions())[0]?.state).toBe("running");
  expect(await source.execution("thread", "follow-turn")).toEqual({ state: "running", exact: true });
  expect(await source.execution("thread", null)).toEqual({ state: "running", exact: false });
  approval = true;
  expect((await source.sessions())[0]?.state).toBe("waiting_external_approval");
  expect(await source.execution("thread", "follow-turn")).toEqual({ state: "waiting_external_approval", exact: false });
  queueResult = { status: "failed", exitCode: 1 };
  expect((await source.send("thread", "op4", "follow")).state).toBe("failed");
  queueResult = { status: "delivery_unknown", exitCode: null };
  expect((await source.send("thread", "op5", "follow")).state).toBe("delivery_unknown");
});


test("Codex missing project, model and thread reject without queueing", async () => {
  let calls = 0;
  const source = new CodexWebSource({
    threads: { listActive: () => [], getThread: () => null },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn() { calls++; throw new Error("not expected"); } },
    queue: { async queue() { calls++; return { status: "failed", exitCode: 1 }; } },
    sessionRoots: [], pathExists: () => false, queueUsable: true, pendingApproval: () => false,
  });
  expect((await source.create({ operationId: "op", projectId: "missing", modelId: null, prompt: "hello", onSessionKnown() {} })).errorCode).toBe("project_missing");
  expect((await source.send("missing", "op2", "hello")).errorCode).toBe("session_missing");
  expect(calls).toBe(0);
});

test("Codex history capability is proven independently from thread listing", async () => {
  const fixture = "tests/fixtures/codex-rollout-web/visible.jsonl";
  const source = new CodexWebSource({
    threads: {
      listActive: () => [{ id: "thread", title: "fixture", updatedAtMs: 1, rolloutPath: fixture }],
      getThread: () => ({ id: "thread", title: "fixture", updatedAtMs: 1, rolloutPath: fixture }),
    },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn() { throw new Error("unused"); } },
    queue: { async queue() { throw new Error("unused"); } },
    sessionRoots: ["tests/fixtures/codex-rollout-web"], pathExists: () => true, queueUsable: false, pendingApproval: () => false,
  });
  await source.sessions();
  expect(source.capabilities()).toMatchObject({ sessionsReadable: true, historyReadable: false, finalReplyReadable: false });
  await source.history("thread", null, 20);
  expect(source.capabilities()).toMatchObject({ sessionsReadable: true, historyReadable: true, finalReplyReadable: true });
});

test("Codex overview capability probe samples catalogs and bounded history without prior navigation", async () => {
  const fixture = "tests/fixtures/codex-rollout-web/visible.jsonl";
  const source = new CodexWebSource({
    threads: {
      listActive: () => [{ id: "thread", title: "fixture", updatedAtMs: 1, rolloutPath: fixture }],
      getThread: () => ({ id: "thread", title: "fixture", updatedAtMs: 1, rolloutPath: fixture }),
    },
    appServer: {
      async listProjects() { return [{ id: "project", index: 1, name: "fixture", roots: ["/repo"], primaryRoot: "/repo", position: 1 }]; },
      async listModels() { return [{ id: "model", displayName: "fixture" }]; },
      async startThreadAndTurn() { throw new Error("unused"); },
    },
    queue: { async queue() { throw new Error("unused"); } },
    sessionRoots: ["tests/fixtures/codex-rollout-web"], pathExists: () => true, queueUsable: true, pendingApproval: () => false,
  });

  expect(source.capabilities()).toMatchObject({ projectsReadable: false, modelsReadable: false, historyReadable: false, createEnabled: false });
  await source.probeCapabilities();
  expect(source.capabilities()).toMatchObject({ sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true, finalReplyReadable: true, createEnabled: true });
});

test("Codex catalog failure before thread start is a definite failure", async () => {
  let starts = 0;
  const source = new CodexWebSource({
    threads: { listActive: () => [], getThread: () => null },
    appServer: {
      async listProjects() { throw new Error("offline"); },
      async listModels() { throw new Error("offline"); },
      async startThreadAndTurn() { starts++; throw new Error("unexpected"); },
    },
    queue: { async queue() { throw new Error("unused"); } },
    sessionRoots: [], pathExists: () => true, queueUsable: true, pendingApproval: () => false,
  });
  expect(await source.create({ operationId: "op", projectId: "project", modelId: null, prompt: "hello", onSessionKnown() {} }))
    .toMatchObject({ state: "failed", sessionId: null, errorCode: "projects_unavailable" });
  expect(starts).toBe(0);
});

test("Codex operation uses rollout lifecycle without hooks and rejects evidence predating submission", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "web-execution-")); const file = join(root, "fixture.jsonl");
  const observedAt = Date.parse("2026-10-02T14:00:00Z");
  const source = new CodexWebSource({
    threads: { listActive: () => [], getThread: () => ({ id: "thread", title: "fixture", updatedAtMs: observedAt, rolloutPath: file }) },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn() { throw new Error("must not dispatch"); } },
    queue: { async queue() { throw new Error("must not queue"); } }, sessionRoots: [root], pathExists: () => true, queueUsable: true, pendingApproval: () => false,
  });
  try {
    writeFileSync(file, JSON.stringify({ type: "event_msg", timestamp: "2026-10-02T14:00:00Z", payload: { type: "task_started", turn_id: "turn" } }));
    expect(await source.execution("thread", null, observedAt - 1)).toEqual({ state: "running", exact: false });
    expect(await source.execution("thread", null, observedAt + 1)).toEqual({ state: "unknown", exact: false });
    writeFileSync(file, JSON.stringify({ type: "event_msg", timestamp: "2026-10-02T14:00:00Z", payload: { type: "task_complete", turn_id: "turn" } }));
    expect(await source.execution("thread", null, observedAt - 1)).toEqual({ state: "session_ended", exact: false });
    expect(await source.execution("thread", "turn", observedAt - 1)).toEqual({ state: "session_ended", exact: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("selected history provides native runtime state without hooks and updates session discovery", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "web-native-state-")); const file = join(root, "fixture.jsonl");
  const thread = { id: "thread", title: "fixture", updatedAtMs: 1, rolloutPath: file };
  const source = new CodexWebSource({ threads: { listActive: () => [thread], getThread: () => thread },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn(): Promise<never> { throw new Error("unused"); } },
    queue: { async queue(): Promise<never> { throw new Error("unused"); } }, sessionRoots: [root], pathExists: () => true, queueUsable: true, pendingApproval: () => false });
  try {
    writeFileSync(file, JSON.stringify({ timestamp: "2026-10-03T10:10:38Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }));
    expect(await source.history("thread", null, 30)).toMatchObject({ sessionState: "running", activeTurnStartedAt: Date.parse("2026-10-03T10:10:38Z") });
    expect(await source.sessions()).toMatchObject([{ state: "running" }]);
    writeFileSync(file, JSON.stringify({ timestamp: "2026-10-03T10:10:55Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } }));
    expect(await source.history("thread", null, 30)).toMatchObject({ sessionState: "idle" });
    expect(await source.sessions()).toMatchObject([{ state: "idle" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex adapter forwards only normalized creation metadata without changing source identity", async () => {
  const source = new CodexWebSource({
    threads: { listActive: () => [
      { id: "desktop", title: "fixture", updatedAtMs: 1, rolloutPath: "/fixture", creationClient: {kind:"desktop",evidence:"originator"} },
      { id: "legacy", title: "fixture", updatedAtMs: 2, rolloutPath: "/fixture" },
    ] },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn(): Promise<never> { throw new Error("unused"); } },
    queue: { async queue(): Promise<never> { throw new Error("unused"); } },
    sessionRoots: [], pathExists: () => true, queueUsable: true, pendingApproval: () => false,
  });
  const items = await source.sessions();
  expect(items.find((item) => item.id === "desktop")).toMatchObject({source:"codex",creationClient:{kind:"desktop",evidence:"originator"}});
  expect(items.find((item) => item.id === "legacy")).not.toHaveProperty("creationClient");
  expect(source.capabilities().sessionsReadable).toBe(true);
});

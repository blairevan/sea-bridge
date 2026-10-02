import { expect, test } from "bun:test";
import type { QueueResult } from "../src/desktop/codex-queue-client.ts";
import { CodexWebSource } from "../src/web/sources/codex.ts";
import type { CodexAppServerClient } from "../src/desktop/codex-app-server-client.ts";

test("Web Codex prompt is raw, catalog coalesces, ownership blocks queue until release", async () => {
  type Start = Parameters<CodexAppServerClient["startThreadAndTurn"]>[0];
  let release: Start["onOwnershipReleased"]; let prompt = ""; let queues = 0; let catalogs = 0; let approval = false; let queueResult: QueueResult = { status: "delivered", exitCode: 0 };
  const source = new CodexWebSource({
    threads: { listActive: () => [{ id: "thread", title: "test", updatedAtMs: 1, rolloutPath: "/missing" }], getThread: () => ({ id: "thread", title: "test", updatedAtMs: 1, rolloutPath: "/missing" }) },
    appServer: {
      async listProjects() { catalogs++; return [{ id: "project", index: 1, name: "fixture", roots: ["/repo"], primaryRoot: "/repo", position: 1 }]; },
      async listModels() { return [{ id: "model", displayName: "fixture" }]; },
      async startThreadAndTurn(input) { prompt = input.prompt; release = input.onOwnershipReleased; input.onThreadStarted?.("thread"); return { threadId: "thread", turnId: "turn", projectId: input.projectId, cwd: input.cwd, model: null }; },
    },
    queue: { async queue() { queues++; return queueResult; } },
    sessionRoots: [], pathExists: () => true, queueUsable: true, pendingApproval: () => approval,
  });
  await Promise.all([source.projects(), source.projects()]); expect(catalogs).toBe(1);
  const result = await source.create({ operationId: "op", projectId: "project", modelId: null, prompt: "hello", onSessionKnown() {} });
  expect(prompt).toBe("hello"); expect(result.state).toBe("accepted");
  expect((await source.send("thread", "op2", "follow")).errorCode).toBe("first_turn_owned"); expect(queues).toBe(0);
  release?.("thread", "turn");
  expect((await source.send("thread", "op3", "follow")).state).toBe("queued"); expect(queues).toBe(1);
  expect((await source.sessions())[0]?.projectId).toBeNull();
  approval = true;
  expect((await source.sessions())[0]?.state).toBe("waiting_external_approval");
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

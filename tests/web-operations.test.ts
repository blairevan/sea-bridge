import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import { dispatchWebOperation } from "../src/web/operations.ts";
import type { WebSource } from "../src/web/sources/types.ts";

test("local snapshot failure stays before the source dispatch boundary", async () => {
  const db = new Database(":memory:"); migrateWeb(db);
  const store = new WebStore(db);
  db.exec("DROP TABLE web_message_snapshots");
  let sourceCalls = 0;
  const source: WebSource = {
    capabilities: () => ({ sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true,
      completeUserHistoryReadable: false, finalReplyReadable: true, createEnabled: true, sendEnabled: true, approvalTransport: null }),
    async sessions() { return []; },
    async projects() { return []; },
    async models() { return []; },
    async history() { return { messages: [], cursor: null, completeUserHistory: false }; },
    async create() { sourceCalls++; return { state: "accepted", sessionId: "unexpected" }; },
    async send() { sourceCalls++; return { state: "accepted", sessionId: "unexpected" }; },
  };
  const request = { operationId: "11111111-1111-4111-8111-111111111111", source: "codex" as const, kind: "create" as const,
    targetId: null, projectId: "project", modelId: null, prompt: "hello" };
  const result = await dispatchWebOperation(request, "device", source, store, randomBytes(32), new WebRedaction([]));
  expect(sourceCalls).toBe(0);
  expect(result).toMatchObject({ state: "failed", errorCode: "local_persistence_failed" });
  expect(store.getOperation(request.operationId)?.state).toBe("failed");
  db.close();
});

test("definite source failures do not leave display snapshots behind", async () => {
  const db = new Database(":memory:"); migrateWeb(db);
  const store = new WebStore(db);
  const source: WebSource = {
    capabilities: () => ({ sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true,
      completeUserHistoryReadable: false, finalReplyReadable: true, createEnabled: true, sendEnabled: true, approvalTransport: null }),
    async sessions() { return []; },
    async projects() { return []; },
    async models() { return []; },
    async history() { return { messages: [], cursor: null, completeUserHistory: false }; },
    async create() { return { state: "failed", sessionId: null, errorCode: "validation_failed" }; },
    async send(id) { return { state: "failed", sessionId: id, errorCode: "busy" }; },
  };
  const request = { operationId: "22222222-2222-4222-8222-222222222222", source: "dsh" as const, kind: "send" as const,
    targetId: "session", projectId: null, modelId: null, prompt: "hello" };
  expect((await dispatchWebOperation(request, "device", source, store, randomBytes(32), new WebRedaction([]))).state).toBe("failed");
  expect(db.query("SELECT 1 FROM web_message_snapshots WHERE operation_id=?").get(request.operationId)).toBeNull();
  db.close();
});

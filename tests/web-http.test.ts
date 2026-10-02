import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import { WebEvents } from "../src/web/events.ts";
import { createWebHandler } from "../src/web/http.ts";
import type { WebSource } from "../src/web/sources/types.ts";

test("HTTP protects reads/writes and durably claims raw requests exactly once", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db);
  const auth = new WebAuth(store); const events = new WebEvents(store);
  let writes = 0; let raw = "";
  const source: WebSource = {
    capabilities: () => ({ sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true, completeUserHistoryReadable: false, finalReplyReadable: true, createEnabled: true, sendEnabled: true, approvalTransport: null }),
    async sessions() { return []; }, async projects() { return []; }, async models() { return []; },
    async history() { return { messages: [], cursor: null, completeUserHistory: false }; },
    async create(input) {
      expect(store.getOperation(input.operationId)?.state).toBe("dispatching");
      writes++; raw = input.prompt; input.onSessionKnown("session-example");
      return { state: "accepted", sessionId: "session-example" };
    }, async send() { throw new Error("unused"); },
  };
  const handler = createWebHandler({ store, auth, events, sources: { codex: source, dsh: source }, pepper: randomBytes(32), redaction: new WebRedaction(["fixture-secret"]), port: 7310, remoteOrigin: null, telegramStatus: () => ({ stopped: false, lastPollSuccessAt: null, pollFailed: false }) });
  const request = (path: string, method = "GET", body?: unknown, cookie?: string, csrf?: string) => handler(new Request("http://127.0.0.1:7310" + path, {
    method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Origin: "http://127.0.0.1:7310", ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-Sea-Bridge-CSRF": csrf } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), "127.0.0.1");
  try {
    expect((await request("/api/status")).status).toBe(401);
    const paired = auth.pair(auth.createPairCode().code, "local", "fixture"); if (!paired) throw new Error("fixture failed");
    const cookie = `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}`;
    const payload = { operationId: randomUUID(), source: "codex", projectId: "project", modelId: null, prompt: "hello fixture-secret" };
    expect((await request("/api/sessions", "POST", payload, cookie)).status).toBe(403);
    expect((await request("/api/sessions", "POST", payload, cookie, paired.csrfToken)).status).toBe(200);
    expect((await request("/api/sessions", "POST", payload, cookie, paired.csrfToken)).status).toBe(200);
    expect(writes).toBe(1); expect(raw).toBe(payload.prompt);
    expect(JSON.stringify(db.query("SELECT * FROM web_message_snapshots").all())).not.toContain("fixture-secret");
    expect((await request("/api/sessions", "POST", { ...payload, prompt: "changed" }, cookie, paired.csrfToken)).status).toBe(409);
    const changed = await request("/api/settings/redaction", "PUT", { enabled: false, expectedVersion: 1 }, cookie, paired.csrfToken);
    expect(changed.headers.get("X-Sea-Bridge-Settings-Version")).toBe("2");
    expect((await request("/api/settings/redaction", "PUT", { enabled: true, expectedVersion: 1 }, cookie, paired.csrfToken)).status).toBe(409);
    expect((await request("/api/sessions?limit=99999", "GET", undefined, cookie)).status).toBe(200);
    expect((await request("/api/sessions?cursor=invalid", "GET", undefined, cookie)).status).toBe(400);
    expect((await request("/api/devices/" + paired.device.id, "DELETE", undefined, cookie, paired.csrfToken)).status).toBe(200);
    expect((await request("/api/status", "GET", undefined, cookie)).status).toBe(401);
  } finally { events.close(); db.close(); }
});

test("pairing body is streaming-bounded before materialization", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db); const events = new WebEvents(store);
  const handler = createWebHandler({ store, auth: new WebAuth(store), events, sources: {}, pepper: randomBytes(32), redaction: new WebRedaction([]), port: 7310, remoteOrigin: null, telegramStatus: () => ({ stopped: true, lastPollSuccessAt: null, pollFailed: false }) });
  const response = await handler(new Request("http://127.0.0.1:7310/api/auth/pair", { method: "POST", headers: { Origin: "http://127.0.0.1:7310", "Content-Type": "application/json" }, body: "x".repeat(4096) }), "127.0.0.1");
  expect(response.status).toBe(413); expect(response.headers.get("Cache-Control")).toBe("no-store");
  events.close(); db.close();
});

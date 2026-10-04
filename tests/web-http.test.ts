import { LOGIN_FIXTURE, LOGIN_HASH, loginFixture } from "./helpers/web-login.ts";
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
  let writes = 0; let raw = ""; let opens = 0;
  const source: WebSource = {
    async openDesktop() { opens++; },
    async attachment() { return { bytes: new Uint8Array([255, 216, 255]), contentType: "image/jpeg" }; },
    capabilities: () => ({ sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true, completeUserHistoryReadable: false, finalReplyReadable: true, createEnabled: true, sendEnabled: true, approvalTransport: null }),
    async sessions() { return [
      { source: "codex", id: "idle", title: "idle", updatedAt: 3, projectId: null, state: "unknown", sendEnabled: true },
      { source: "codex", id: "active", title: "active", updatedAt: 2, projectId: null, state: "running", sendEnabled: true },
    ]; }, async projects() { return []; }, async models() { return []; },
    async history() { return { messages: [], cursor: null, completeUserHistory: false }; },
    async execution() { return { state: "running", exact: true }; },
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
    auth.setAccount(LOGIN_FIXTURE.username, LOGIN_HASH);
    expect((await request("/api/auth/pair", "POST", { code: "12345678" })).status).toBe(404);
    expect((await request("/api/auth/login", "POST", { ...LOGIN_FIXTURE, name: "fixture-secret" })).status).toBe(200);
    expect(JSON.stringify(db.query("SELECT name FROM web_device_sessions").all())).not.toContain("fixture-secret");
    const paired = await loginFixture(auth); if (!paired) throw new Error("fixture failed");
    const cookie = `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}`;
    const imagePath = "/api/sessions/codex/thread/attachments/rollout-1/0";
    expect((await request(imagePath)).status).toBe(401);
    const image = await request(imagePath, "GET", undefined, cookie);
    expect(image.status).toBe(200); expect(image.headers.get("Content-Type")).toBe("image/jpeg");
    expect(image.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255]));
    const openPath = "/api/sessions/codex/11111111-1111-4111-8111-111111111111/open-desktop";
    expect((await request(openPath, "POST")).status).toBe(401);
    expect((await request(openPath, "POST", undefined, cookie)).status).toBe(403);
    expect(opens).toBe(0);
    const opened = await request(openPath, "POST", undefined, cookie, paired.csrfToken);
    expect(opened.status).toBe(200);
    expect((await opened.json()).data.status).toBe("open_requested");
    expect(opens).toBe(1); expect(writes).toBe(0);
    const filtered = await request("/api/sessions?source=codex&activity=running&limit=1", "GET", undefined, cookie);
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).data.items.map((item: { id: string }) => item.id)).toEqual(["active"]);
    expect((await request("/api/sessions?activity=invalid", "GET", undefined, cookie)).status).toBe(400);
    const exact = await request("/api/sessions?source=codex&sessionId=idle&limit=1", "GET", undefined, cookie);
    expect((await exact.json()).data.items.map((item: { id: string }) => item.id)).toEqual(["idle"]);
    const payload = { operationId: randomUUID(), source: "codex", projectId: "project", modelId: null, prompt: "hello fixture-secret" };
    expect((await request("/api/sessions", "POST", payload, cookie)).status).toBe(403);
    expect((await request("/api/sessions", "POST", payload, cookie, paired.csrfToken)).status).toBe(200);
    const operationResponse = await request("/api/operations/" + payload.operationId, "GET", undefined, cookie);
    expect(operationResponse.status).toBe(200);
    expect((await operationResponse.json()).data.execution).toEqual({ state: "running", exact: true });
    expect((await request("/api/sessions", "POST", payload, cookie, paired.csrfToken)).status).toBe(200);
    expect(writes).toBe(1); expect(raw).toBe(payload.prompt);
    expect(JSON.stringify(db.query("SELECT * FROM web_message_snapshots").all())).not.toContain("fixture-secret");
    expect((await request("/api/sessions", "POST", { ...payload, prompt: "changed" }, cookie, paired.csrfToken)).status).toBe(409);
    const changed = await request("/api/settings/redaction", "PUT", { enabled: false, expectedVersion: 1 }, cookie, paired.csrfToken);
    expect(changed.headers.get("X-Sea-Bridge-Settings-Version")).toBe("2");
    expect((await request("/api/settings/redaction", "PUT", { enabled: true, expectedVersion: 1 }, cookie, paired.csrfToken)).status).toBe(409);
    expect((await request("/api/sessions?limit=99999", "GET", undefined, cookie)).status).toBe(200);
    expect((await request("/api/sessions?cursor=invalid", "GET", undefined, cookie)).status).toBe(400);
    const cjk = { operationId: randomUUID(), source: "codex", projectId: "project", modelId: null, prompt: "界".repeat(32000) };
    expect((await request("/api/sessions", "POST", cjk, cookie, paired.csrfToken)).status).toBe(200);
    expect(raw).toBe(cjk.prompt); expect(writes).toBe(2);
    expect((await request("/api/devices/" + paired.device.id, "DELETE", undefined, cookie, paired.csrfToken)).status).toBe(200);
    expect((await request("/api/status", "GET", undefined, cookie)).status).toBe(401);
  } finally { events.close(); db.close(); }
});

test("login body is streaming-bounded before materialization", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db); const events = new WebEvents(store);
  const handler = createWebHandler({ store, auth: new WebAuth(store), events, sources: {}, pepper: randomBytes(32), redaction: new WebRedaction([]), port: 7310, remoteOrigin: null, telegramStatus: () => ({ stopped: true, lastPollSuccessAt: null, pollFailed: false }) });
  const response = await handler(new Request("http://127.0.0.1:7310/api/auth/login", { method: "POST", headers: { Origin: "http://127.0.0.1:7310", "Content-Type": "application/json" }, body: "x".repeat(4096) }), "127.0.0.1");
  expect(response.status).toBe(413); expect(response.headers.get("Cache-Control")).toBe("no-store");
  events.close(); db.close();
});

test("revocation during body upload prevents settings and source writes", async () => {
  for (const path of ["/api/settings/redaction", "/api/sessions"]) {
    const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db);
    const auth = new WebAuth(store); const events = new WebEvents(store);
    const paired = await loginFixture(auth);
    if (!paired) throw new Error("fixture failed");
    let writes = 0;
    const source: WebSource = {
      capabilities: () => ({ sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true, completeUserHistoryReadable: false, finalReplyReadable: true, createEnabled: true, sendEnabled: true, approvalTransport: null }),
      async sessions() { return []; }, async projects() { return []; }, async models() { return []; },
      async history() { return { messages: [], cursor: null, completeUserHistory: false }; },
      async create() { writes++; return { state: "accepted", sessionId: "created" }; },
      async send() { writes++; return { state: "accepted", sessionId: "created" }; },
    };
    const handler = createWebHandler({ store, auth, events, sources: { codex: source }, pepper: randomBytes(32), redaction: new WebRedaction([]), port: 7310, remoteOrigin: null, telegramStatus: () => ({ stopped: true, lastPollSuccessAt: null, pollFailed: false }) });
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(path.includes("settings")
        ? { enabled: false, expectedVersion: 1 }
        : { operationId: randomUUID(), source: "codex", projectId: "project", prompt: "hello" }))); controller.close(); };
    } });
    try {
      const pending = handler(new Request("http://127.0.0.1:7310" + path, { method: path.includes("settings") ? "PUT" : "POST", headers: {
        Origin: "http://127.0.0.1:7310", "Content-Type": "application/json", Cookie: `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}`, "X-Sea-Bridge-CSRF": paired.csrfToken,
      }, body }), "127.0.0.1");
      store.revokeDevice(paired.device.id, Date.now()); finish();
      expect((await pending).status).toBe(401);
      expect(writes).toBe(0); expect(store.getSettings().version).toBe(1);
    } finally { events.close(); db.close(); }
  }
});

test("remote password login requires HTTPS and emits Secure host-only cookies", async () => {
  for (const origin of ["http://100.112.22.85:7310", "https://machine.example.test"]) {
    const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db);
    const auth = new WebAuth(store); const events = new WebEvents(store);
    const handler = createWebHandler({ store, auth, events, sources: {}, pepper: randomBytes(32), redaction: new WebRedaction([]), port: 7310, remoteOrigin: origin, telegramStatus: () => ({ stopped: true, lastPollSuccessAt: null, pollFailed: false }) });
    try {
      auth.setAccount(LOGIN_FIXTURE.username, LOGIN_HASH);
      const response = await handler(new Request(origin + "/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(LOGIN_FIXTURE) }), "127.0.0.1");
      if (origin.startsWith("http:")) { expect(response.status).toBe(403); expect(response.headers.get("Set-Cookie")).toBeNull(); continue; }
      expect(response.status).toBe(200);
      expect(response.headers.get("Set-Cookie")?.includes("Secure")).toBe(origin.startsWith("https:"));
      expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
      expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");
      const issued = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const csrf = /sea_csrf=([^;]+)/.exec(issued)?.[1];
      if (!csrf) throw new Error("fixture csrf missing");
      const logout = await handler(new Request(origin + "/api/auth/logout", { method: "POST", headers: { Origin: origin, Cookie: issued, "X-Sea-Bridge-CSRF": csrf } }), "127.0.0.1");
      expect(logout.status).toBe(200);
      expect(logout.headers.get("Set-Cookie")?.includes("Secure")).toBe(origin.startsWith("https:"));
    } finally { events.close(); db.close(); }
  }
});


test("creation client filtering excludes dsh, matches legacy unknown, and precedes pagination", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db);
  const auth = new WebAuth(store); const paired = await loginFixture(auth);
  if (!paired) throw new Error("fixture failed");
  const caps = { sessionsReadable: true, projectsReadable: true, modelsReadable: true, historyReadable: true,
    completeUserHistoryReadable: false, finalReplyReadable: true, createEnabled: false, sendEnabled: false, approvalTransport: null } as const;
  const base = { title: "fixture", projectId: null, state: "unknown", sendEnabled: false } as const;
  const codex: WebSource = { capabilities: () => caps,
    sessions: async () => [
      { ...base, source: "codex", id: "legacy", updatedAt: 5 },
      { ...base, source: "codex", id: "desktop1", updatedAt: 4, creationClient: { kind: "desktop", evidence: "originator" } },
      { ...base, source: "codex", id: "desktop2", updatedAt: 3, creationClient: { kind: "desktop", evidence: "originator" } },
      { ...base, source: "codex", id: "unknown", updatedAt: 2, creationClient: { kind: "unknown", evidence: "none" } },
    ], projects: async () => [], models: async () => [],
    history: async () => ({ messages: [], cursor: null, completeUserHistory: false }),
    create: async () => { throw new Error("unused"); }, send: async () => { throw new Error("unused"); },
  };
  const dsh: WebSource = { ...codex, sessions: async () => { throw new Error("dsh unavailable"); } };
  const handler = createWebHandler({ store, auth, events: new WebEvents(store), sources: { codex, dsh },
    pepper: randomBytes(32), redaction: new WebRedaction([]), port: 7310, remoteOrigin: null,
    telegramStatus: () => ({ stopped: false, lastPollSuccessAt: null, pollFailed: false }) });
  const read = (query: string) => handler(new Request("http://127.0.0.1:7310/api/sessions?" + query, {
    headers: { Cookie: `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}` },
  }), "127.0.0.1");
  try {
    const first = (await (await read("creationClient=desktop&limit=1")).json()).data;
    expect(first.items.map((item: { id: string }) => item.id)).toEqual(["desktop1"]);
    expect(first.cursor).toBe("1");
    const second = (await (await read("creationClient=desktop&limit=1&cursor=1")).json()).data;
    expect(second.items.map((item: { id: string }) => item.id)).toEqual(["desktop2"]);
    expect(second.cursor).toBeNull();
    const unknown = (await (await read("creationClient=unknown")).json()).data;
    expect(unknown.items.map((item: { id: string }) => item.id)).toEqual(["legacy", "unknown"]);
    expect(unknown.partial).toBe(false);
    expect((await (await read("source=dsh&creationClient=unknown")).json()).data.items).toEqual([]);
    expect((await read("source=all&creationClient=desktop")).status).toBe(400);
    expect((await read("creationClient=vscode")).status).toBe(400);
    expect((await read("creationClient=pending")).status).toBe(400);
    expect((await read("creationClient=")).status).toBe(400);
  } finally { db.close(); }
});

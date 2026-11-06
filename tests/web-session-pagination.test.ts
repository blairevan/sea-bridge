import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CodexWebSource } from "../src/web/sources/codex.ts";
import { createWebHandler } from "../src/web/http.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import type { WebSession } from "../src/web/sources/types.ts";
import { loginFixture } from "./helpers/web-login.ts";

/** Exercise the real authenticated route, including merged source ordering and evidence refresh. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "status-pages-"));
  const path = join(root, "idle.jsonl");
  writeFileSync(path, JSON.stringify({ type: "event_msg", timestamp: "2026-11-06T00:00:00Z", payload: { type: "task_complete", turn_id: "turn" } }) + "\n");
  const threads = [2, 1].map((updatedAtMs) => ({ id: `codex-${updatedAtMs}`, title: "fixture", updatedAtMs, rolloutPath: path }));
  const codex = new CodexWebSource({
    threads: { listActive: () => threads, getThread: (id) => threads.find((thread) => thread.id === id) ?? null },
    catalogs: { async listProjects() { return []; }, async listModels() { return []; } },
    actions: { async startThreadAndTurn(): Promise<never> { throw new Error("unused"); } },
    queue: { async queue(): Promise<never> { throw new Error("unused"); } },
    sessionRoots: [root], pathExists: () => true, queueUsable: false, pendingApproval: () => false,
    activity: (id) => id === "codex-1" ? { state: "active", turnId: "turn" } : null,
  });
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db);
  const auth = new WebAuth(store); const events = new WebEvents(store); const paired = await loginFixture(auth);
  const dsh = { capabilities: () => codex.capabilities(), async sessions(): Promise<WebSession[]> { return [4, 3].map((updatedAt) => ({ source: "dsh", id: `dsh-${updatedAt}`, title: "fixture", updatedAt, projectId: null, state: "idle", sendEnabled: false })); },
    async projects() { return []; }, async models() { return []; }, async history() { return { messages: [], cursor: null, completeUserHistory: false }; },
    async create(): Promise<never> { throw new Error("unused"); }, async send(): Promise<never> { throw new Error("unused"); } };
  const handler = createWebHandler({ store, auth, events, sources: { codex, dsh }, pepper: randomBytes(32), redaction: new WebRedaction([]), port: 7310, remoteOrigin: null,
    telegramStatus: () => ({ stopped: true, lastPollSuccessAt: null, pollFailed: false }) });
  return {
    threads, root, path,
    async get(query: string): Promise<{ items: WebSession[]; cursor: string | null; partial: boolean; scanLimited: boolean }> {
      const response = await handler(new Request("http://127.0.0.1:7310/api/sessions?" + query, { headers: { Cookie: `sea_session=${paired.sessionToken}; sea_csrf=${paired.csrfToken}` } }), "127.0.0.1");
      expect(response.status).toBe(200);
      const envelope = await response.json() as { data: { items: WebSession[]; cursor: string | null; partial: boolean; scanLimited: boolean } };
      return envelope.data;
    },
    close() { events.close(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("activity filtering cannot return a stale running row that was outside the raw first page", async () => {
  const f = await fixture();
  try { expect((await f.get("source=codex&activity=running&limit=1")).items).toEqual([]); }
  finally { f.close(); }
});

test("merged-source pagination refreshes the Codex IDs actually returned on the global page", async () => {
  const f = await fixture();
  try { expect((await f.get("cursor=2&limit=1")).items).toMatchObject([{ id: "codex-2", state: "idle" }]); }
  finally { f.close(); }
});

test("activity scan budget returns a resumable cursor instead of claiming unchecked rows are unknown", async () => {
  const f = await fixture();
  try {
    f.threads.splice(0);
    for (let i = 1; i <= 101; i++) f.threads.push({ id: `idle-${i}`, title: "fixture", updatedAtMs: i, rolloutPath: f.path });
    const activePath = join(f.root, "active.jsonl");
    writeFileSync(activePath, JSON.stringify({ type: "event_msg", timestamp: "2026-11-06T00:00:00Z", payload: { type: "task_started", turn_id: "active" } }) + "\n");
    f.threads.push({ id: "active", title: "fixture", updatedAtMs: 0, rolloutPath: activePath });
    const first = await f.get("source=codex&activity=running&limit=1");
    expect(first).toMatchObject({ items: [], cursor: "100", partial: true, scanLimited: true });
    const next = await f.get(`source=codex&activity=running&limit=1&cursor=${first.cursor}`);
    expect(next.items).toMatchObject([{ id: "active", state: "running" }]);
    expect(next.cursor).toBeNull();
  } finally { f.close(); }
});

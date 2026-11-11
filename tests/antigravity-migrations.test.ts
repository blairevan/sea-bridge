import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { AntigravityStore } from "../src/antigravity/store.ts";

describe("Antigravity migrations and store", () => {
  test("StateDb initializes antigravity_* tables without requiring migrateWeb", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-state-db-"));
    try {
      const stateDb = new StateDb(join(root, "state.db"));
      const tables = stateDb.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'antigravity_%' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual([
        "antigravity_approvals",
        "antigravity_executions",
        "antigravity_message_links",
        "antigravity_messages",
        "antigravity_outbox",
        "antigravity_projects",
        "antigravity_sessions",
        "antigravity_telegram_state",
      ]);

      const store = new AntigravityStore(stateDb.db);
      store.upsertProject({
        id: "proj-1",
        name: "SeaBridge",
        rootPath: "/opt/app/aitools/sea-bridge",
        policyVersion: "v1",
        updatedAt: 100,
      });
      expect(store.listProjects()).toEqual([
        {
          id: "proj-1",
          name: "SeaBridge",
          rootPath: "/opt/app/aitools/sea-bridge",
          policyVersion: "v1",
          updatedAt: 100,
        },
      ]);

      store.upsertSession({
        sessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85",
        nativeSessionId: "9d3547fd-5f23-4178-b143-38a82ad31d85",
        projectId: "proj-1",
        cwd: "/opt/app/aitools/sea-bridge",
        title: "Initial session",
        modelId: "gemini-4-argon",
        reasoningEffort: "medium",
        modeId: "default",
        status: "idle",
        completeHistory: true,
        snapshotGeneration: 1,
        createdAt: 100,
        updatedAt: 100,
      });
      expect(store.getSession("9d3547fd-5f23-4178-b143-38a82ad31d85")?.modelId).toBe("gemini-4-argon");
      expect(store.getSession("9d3547fd-5f23-4178-b143-38a82ad31d85")?.reasoningEffort).toBe("medium");

      stateDb.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrateWeb v2 -> v3 preserves codex/dsh operations, snapshots, cascade FK, and admits antigravity", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON;");
      // Simulate legacy v2 schema before v3
      db.exec(`
        CREATE TABLE web_schema_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE web_settings(
          id INTEGER PRIMARY KEY CHECK(id=1), redaction_enabled INTEGER NOT NULL CHECK(redaction_enabled IN (0,1)), version INTEGER NOT NULL);
        INSERT INTO web_settings VALUES(1,1,1);
        CREATE TABLE web_device_sessions(
          id TEXT PRIMARY KEY, name TEXT NOT NULL, session_hash TEXT NOT NULL UNIQUE,
          paired_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE TABLE web_csrf_tokens(
          device_id TEXT PRIMARY KEY REFERENCES web_device_sessions(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE web_operations(
          id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','send')),
          source TEXT NOT NULL CHECK(source IN ('codex','dsh')), device_id TEXT NOT NULL,
          target_id TEXT, project_id TEXT, model_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('received','dispatching','queued','accepted','failed','delivery_unknown')),
          session_id TEXT, turn_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE web_message_snapshots(
          operation_id TEXT PRIMARY KEY REFERENCES web_operations(id) ON DELETE CASCADE,
          source TEXT NOT NULL, session_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE web_logs(
          id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, event TEXT NOT NULL,
          fields_json TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE web_audit(
          id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, action TEXT NOT NULL,
          detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE web_admin_account(
          id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL,
          password_hash TEXT NOT NULL, revision INTEGER NOT NULL);
        INSERT INTO web_schema_migrations VALUES(1),(2);
      `);

      db.query(
        "INSERT INTO web_operations VALUES('op-codex','d1','create','codex','dev1',NULL,'p1','gpt-5','accepted','s-codex','t1',NULL,10,11)"
      ).run();
      db.query(
        "INSERT INTO web_operations VALUES('op-dsh','d2','send','dsh','dev1','s-dsh',NULL,NULL,'accepted','s-dsh',NULL,NULL,20,21)"
      ).run();
      db.query("INSERT INTO web_message_snapshots VALUES('op-codex','codex','s-codex','hello codex',10)").run();
      db.query("INSERT INTO web_message_snapshots VALUES('op-dsh','dsh','s-dsh','hello dsh',20)").run();

      migrateWeb(db);

      expect(db.query("SELECT version FROM web_schema_migrations ORDER BY version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });

      const store = new WebStore(db);
      expect(store.getOperation("op-codex")?.source).toBe("codex");
      expect(store.getOperation("op-dsh")?.source).toBe("dsh");
      expect(store.listAcceptedMessageSnapshots("codex", "s-codex")).toHaveLength(1);
      expect(store.listAcceptedMessageSnapshots("dsh", "s-dsh")).toHaveLength(1);

      // Verify ON DELETE CASCADE still works on web_message_snapshots -> web_operations
      db.query("DELETE FROM web_operations WHERE id='op-codex'").run();
      expect(db.query("SELECT * FROM web_message_snapshots WHERE operation_id='op-codex'").get()).toBeNull();

      // Verify antigravity source is now accepted and invalid source is rejected
      expect(
        store.claimOperation({
          id: "op-agy",
          digest: "d3",
          kind: "create",
          source: "antigravity",
          deviceId: "dev1",
          targetId: null,
          projectId: "proj-1",
          modelId: "gemini-4-argon",
          createdAt: 30,
        })
      ).toBe("new");

      expect(() =>
        db
          .query(
            "INSERT INTO web_operations(id,digest,kind,source,device_id,state,created_at,updated_at) VALUES('bad','d','send','invalid','dev','received',1,1)"
          )
          .run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("transitionQueuedOperation supports queued -> accepted | failed | delivery_unknown", () => {
    const db = new Database(":memory:");
    try {
      migrateWeb(db);
      const store = new WebStore(db);
      store.claimOperation({
        id: "op-q1",
        digest: "dq1",
        kind: "create",
        source: "antigravity",
        deviceId: "dev1",
        targetId: null,
        projectId: "p1",
        modelId: "gemini-4-argon",
        createdAt: 100,
      });
      db.query("INSERT INTO web_message_snapshots(operation_id,source,session_id,text,created_at) VALUES('op-q1','antigravity','s-agy','prompt text',100)").run();

      expect(store.transitionOperation("op-q1", "received", "dispatching", 101)).toBe(true);
      store.setOperationSession("op-q1", "s-agy", 102, "exec-1");
      expect(store.transitionOperation("op-q1", "dispatching", "queued", 103)).toBe(true);

      // While queued, snapshot is not yet in accepted list
      expect(store.listAcceptedMessageSnapshots("antigravity", "s-agy")).toEqual([]);

      // Cannot transition queued back to dispatching
      expect(store.transitionQueuedOperation("op-q1", "dispatching" as any, 104)).toBe(false);

      // Transition queued -> accepted
      expect(store.transitionQueuedOperation("op-q1", "accepted", 105)).toBe(true);
      expect(store.getOperation("op-q1")).toMatchObject({
        state: "accepted",
        sessionId: "s-agy",
        turnId: "exec-1",
      });
      expect(store.listAcceptedMessageSnapshots("antigravity", "s-agy")).toEqual([
        { id: "op-q1", role: "user", text: "prompt text", createdAt: 100 },
      ]);
    } finally {
      db.close();
    }
  });
});

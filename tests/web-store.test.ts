import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { operationDigest, loadOperationPepper, tokenHash } from "../src/web/crypto.ts";

describe("Web isolated persistence", () => {
  test("upgrades on disk without changing legacy rows, idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "web-store-"));
    try {
      const path = join(root, "state.db");
      const state = new StateDb(path);
      state.db.run("INSERT INTO capabilities(name,status,updated_at) VALUES ('legacy','verified',1)");
      state.close();
      const db = new Database(path);
      migrateWeb(db);
      migrateWeb(db);
      expect(db.query("SELECT status FROM capabilities WHERE name='legacy'").get()).toEqual({ status: "verified" });
      expect(new WebStore(db).getSettings()).toEqual({ redactionEnabled: true, version: 1 });
      expect(db.query("SELECT count(*) AS count FROM web_schema_migrations").get()).toEqual({ count: 1 });
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("failed migration rolls back schema and version", () => {
    const db = new Database(":memory:");
    expect(() => migrateWeb(db, () => { throw new Error("injected"); })).toThrow("injected");
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'web_%'").all()).toEqual([]);
    db.close();
  });

  test("settings update uses compare-and-set and audit atomically", () => {
    const db = new Database(":memory:"); migrateWeb(db);
    const store = new WebStore(db);
    expect(store.setRedaction(false, 1, "device", 10)).toEqual({ redactionEnabled: false, version: 2 });
    expect(store.setRedaction(true, 1, "other", 11)).toBeNull();
    expect(store.getSettings().version).toBe(2);
    expect(db.query("SELECT count(*) AS count FROM web_audit").get()).toEqual({ count: 1 });
    db.close();
  });

  test("hash-only sessions and CSRF expire, revoke, and throttle touches", () => {
    const db = new Database(":memory:"); migrateWeb(db);
    const store = new WebStore(db);
    store.createDevice({ id: "device", name: "test", sessionHash: tokenHash("session-fixture"), csrfHash: tokenHash("csrf-fixture"), pairedAt: 1, expiresAt: 100000 });
    expect(store.findDevice(tokenHash("session-fixture"), 20)?.id).toBe("device");
    expect(store.verifyCsrf("device", tokenHash("csrf-fixture"), 20)).toBe(true);
    expect(store.findDevice(tokenHash("session-fixture"), 100000)).toBeNull();
    store.touchDevice("device", 30);
    expect(store.listDevices()[0]?.lastActiveAt).toBe(1);
    store.touchDevice("device", 60001);
    expect(store.listDevices()[0]?.lastActiveAt).toBe(60001);
    store.revokeDevice("device", 60002);
    expect(store.findDevice(tokenHash("session-fixture"), 60003)).toBeNull();
    expect(store.verifyCsrf("device", tokenHash("csrf-fixture"), 60003)).toBe(false);
    expect(JSON.stringify(db.query("SELECT * FROM web_device_sessions").all())).not.toContain("session-fixture");
    expect(JSON.stringify(db.query("SELECT * FROM web_csrf_tokens").all())).not.toContain("csrf-fixture");
    store.cleanup(100001);
    expect(store.listDevices()).toEqual([]);
    db.close();
  });

  test("operation claim is immutable, recoverable, and persists early session id", () => {
    const db = new Database(":memory:"); migrateWeb(db);
    const store = new WebStore(db);
    const request = { id: "op", digest: "digest", kind: "create" as const, source: "codex" as const, deviceId: "device", targetId: null, projectId: "project", modelId: null, createdAt: 1 };
    expect(store.claimOperation(request)).toBe("new");
    expect(store.claimOperation(request)).toBe("duplicate");
    expect(store.claimOperation({ ...request, digest: "different" })).toBe("mismatch");
    expect(store.transitionOperation("op", "received", "dispatching", 2)).toBe(true);
    store.setOperationSession("op", "session", 3);
    expect(store.recoverOperations(4)).toBe(1);
    expect(store.getOperation("op")).toMatchObject({ state: "delivery_unknown", sessionId: "session" });
    expect(store.transitionOperation("op", "delivery_unknown", "dispatching", 5)).toBe(false);
    expect(store.recoverOperations(6)).toBe(0);
    db.close();
  });

  test("private pepper preserves HMAC across restart and never silently regenerates", () => {
    const root = mkdtempSync(join(tmpdir(), "web-pepper-"));
    try {
      const path = join(root, "operation.key");
      const key = loadOperationPepper(path, false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(operationDigest(key, { prompt: "low entropy" })).toBe(operationDigest(loadOperationPepper(path, true), { prompt: "low entropy" }));
      expect(readFileSync(path).length).toBe(32);
      unlinkSync(path);
      expect(() => loadOperationPepper(path, true)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("disk claims compare across restart and reject corrupt pepper", () => {
    const root = mkdtempSync(join(tmpdir(), "web-restart-"));
    try {
      const path = join(root, "state.db"); const pepperPath = join(root, "operation.key");
      const first = new Database(path); migrateWeb(first);
      const request = { source: "dsh", target: "session", prompt: "hello" };
      const digest = operationDigest(loadOperationPepper(pepperPath, false), request);
      const claim = { id: "restart", digest, kind: "send" as const, source: "dsh" as const,
        deviceId: "device", targetId: "session", projectId: null, modelId: null, createdAt: 1 };
      expect(new WebStore(first).claimOperation(claim)).toBe("new"); first.close();
      const second = new Database(path); const store = new WebStore(second);
      expect(store.claimOperation({ ...claim, digest: operationDigest(loadOperationPepper(pepperPath, store.operationsExist()), request) })).toBe("duplicate");
      writeFileSync(pepperPath, "corrupt", { mode: 0o600 });
      expect(() => loadOperationPepper(pepperPath, true)).toThrow("web_pepper_invalid"); second.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("bounded retention removes old records and caps count", () => {
    const db = new Database(":memory:"); migrateWeb(db);
    const store = new WebStore(db);
    const insert = db.query("INSERT INTO web_logs(level,event,fields_json,created_at) VALUES ('info','test','{}',?)");
    db.transaction(() => { for (let i = 0; i < 10002; i++) insert.run(i + 1); })();
    store.cleanup(10003);
    expect(db.query("SELECT count(*) AS count FROM web_logs").get()).toEqual({ count: 10000 });
    store.cleanup(8 * 86400000);
    expect(db.query("SELECT count(*) AS count FROM web_logs").get()).toEqual({ count: 0 });
    db.close();
  });
});

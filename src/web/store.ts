import type { Database } from "bun:sqlite";
import { safeEqual } from "./crypto.ts";

/** Persisted Web settings snapshot used consistently for an entire response. */
export interface WebSettings { redactionEnabled: boolean; version: number; }
/** Device identity with no raw credential material. */
export interface WebDevice { id: string; name: string; pairedAt: number; lastActiveAt: number; expiresAt: number; revokedAt: number | null; }
/** Single administrator credential; never include this projection in HTTP responses. */
export interface WebAccount { username: string; passwordHash: string; revision: number; }
/** State vocabulary separates submission acceptance from source execution. */
export type OperationState = "received" | "dispatching" | "queued" | "accepted" | "failed" | "delivery_unknown";
/** Immutable request identity supplied to the atomic operation claim. */
export interface OperationClaim {
  id: string; digest: string; kind: "create" | "send"; source: "codex" | "dsh";
  deviceId: string; targetId: string | null; projectId: string | null; modelId: string | null; createdAt: number;
}
/** Safe operation projection; digest stays internal to the store. */
export interface WebOperation {
  id: string; kind: "create" | "send"; source: "codex" | "dsh"; deviceId: string;
  targetId: string | null; projectId: string | null; modelId: string | null; state: OperationState;
  sessionId: string | null; turnId: string | null; errorCode: string | null; createdAt: number; updatedAt: number;
}
const DEVICE_COLUMNS = "id,name,paired_at AS pairedAt,last_active_at AS lastActiveAt,expires_at AS expiresAt,revoked_at AS revokedAt";
const OP_COLUMNS = "id,kind,source,device_id AS deviceId,target_id AS targetId,project_id AS projectId,model_id AS modelId,state,session_id AS sessionId,turn_id AS turnId,error_code AS errorCode,created_at AS createdAt,updated_at AS updatedAt";

/** Web-only persistence; callers must filter content before storage. */
export class WebStore {
  /** Use the core database connection after isolated Web migration succeeds. */
  constructor(readonly db: Database) {}

  /** Read the current administrator credential for verification and revision fencing. */
  getAccount(): WebAccount | null {
    return this.db.query("SELECT username,password_hash AS passwordHash,revision FROM web_admin_account WHERE id=1").get() as WebAccount | null;
  }

  /** Atomically rotate credentials and revoke every prior browser session. */
  setAccount(username: string, passwordHash: string, now: number): void {
    this.db.transaction(() => {
      this.db.query(`INSERT INTO web_admin_account VALUES(1,?,?,1)
        ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,revision=revision+1`).run(username, passwordHash);
      this.db.query("UPDATE web_device_sessions SET revoked_at=? WHERE revoked_at IS NULL").run(now);
      this.audit("local-admin", "account_changed", "{}", now);
    })();
  }

  /** Read a complete singleton display policy snapshot. */
  getSettings(): WebSettings {
    const row = this.db.query("SELECT redaction_enabled AS enabled,version FROM web_settings WHERE id=1").get() as { enabled: number; version: number } | null;
    if (!row) throw new Error("web_settings_missing");
    return { redactionEnabled: row.enabled === 1, version: row.version };
  }

  /** Atomically update the policy and append its audit trail. */
  setRedaction(enabled: boolean, expected: number, deviceId: string, now: number): WebSettings | null {
    return this.db.transaction(() => {
      const result = this.db.query("UPDATE web_settings SET redaction_enabled=?,version=version+1 WHERE id=1 AND version=?").run(enabled ? 1 : 0, expected);
      if (!result.changes) return null;
      this.audit(deviceId, "redaction_changed", JSON.stringify({ enabled }), now);
      return this.getSettings();
    })();
  }

  /** Insert credential hashes and absolute expiry in one transaction. */
  createDevice(input: { id: string; name: string; sessionHash: string; csrfHash: string; pairedAt: number; expiresAt: number }): void {
    this.db.transaction(() => {
      this.db.query("INSERT INTO web_device_sessions VALUES(?,?,?,?,?,?,NULL)").run(input.id, input.name, input.sessionHash, input.pairedAt, input.pairedAt, input.expiresAt);
      this.db.query("INSERT INTO web_csrf_tokens VALUES(?,?,?)").run(input.id, input.csrfHash, input.expiresAt);
    })();
  }

  /** Find only active, unexpired paired device sessions. */
  findDevice(hash: string, now: number): WebDevice | null {
    return this.db.query(`SELECT ${DEVICE_COLUMNS} FROM web_device_sessions WHERE session_hash=? AND expires_at>? AND revoked_at IS NULL`).get(hash, now) as WebDevice | null;
  }

  /** Validate a token hash only when its device is still authorized. */
  verifyCsrf(deviceId: string, hash: string, now: number): boolean {
    const row = this.db.query("SELECT c.token_hash FROM web_csrf_tokens c JOIN web_device_sessions d ON d.id=c.device_id WHERE d.id=? AND d.revoked_at IS NULL AND d.expires_at>? AND c.expires_at>?").get(deviceId, now, now) as { token_hash: string } | null;
    return Boolean(row && safeEqual(row.token_hash, hash));
  }

  /** Throttle activity writes to at most once a minute per device. */
  touchDevice(id: string, now: number): void {
    this.db.query("UPDATE web_device_sessions SET last_active_at=? WHERE id=? AND last_active_at<=? AND revoked_at IS NULL").run(now, id, now - 60000);
  }

  /** List device metadata without credential hashes. */
  listDevices(): WebDevice[] {
    return this.db.query(`SELECT ${DEVICE_COLUMNS} FROM web_device_sessions ORDER BY paired_at DESC LIMIT 100`).all() as WebDevice[];
  }

  /** Resolve one device for stream expiry independently of the bounded management list. */
  getDevice(id: string): WebDevice | null {
    return this.db.query(`SELECT ${DEVICE_COLUMNS} FROM web_device_sessions WHERE id=?`).get(id) as WebDevice | null;
  }

  /** Revoke persistently; event-stream closure is handled by the HTTP layer. */
  revokeDevice(id: string, now: number): boolean {
    return this.db.query("UPDATE web_device_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, id).changes > 0;
  }

  /** Claim a request once; a changed payload never replaces a prior claim. */
  claimOperation(input: OperationClaim): "new" | "duplicate" | "mismatch" {
    return this.db.transaction(() => {
      const prior = this.db.query("SELECT digest FROM web_operations WHERE id=?").get(input.id) as { digest: string } | null;
      if (prior) return safeEqual(prior.digest, input.digest) ? "duplicate" : "mismatch";
      this.db.query("INSERT INTO web_operations(id,digest,kind,source,device_id,target_id,project_id,model_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'received',?,?)").run(input.id, input.digest, input.kind, input.source, input.deviceId, input.targetId, input.projectId, input.modelId, input.createdAt, input.createdAt);
      return "new";
    })();
  }

  /** Retrieve safe operation state including partial creation identifiers. */
  getOperation(id: string): WebOperation | null {
    return this.db.query(`SELECT ${OP_COLUMNS} FROM web_operations WHERE id=?`).get(id) as WebOperation | null;
  }

  /** Merge only prompts the source explicitly accepted; failed/ambiguous writes never become fake history. */
  listAcceptedMessageSnapshots(source: "codex" | "dsh", sessionId: string, limit = 100): Array<{ id: string; role: "user"; text: string; createdAt: number }> {
    const bounded = Math.max(1, Math.min(100, limit));
    return this.db.query(`
      SELECT * FROM (SELECT snapshots.operation_id AS id,'user' AS role,snapshots.text,snapshots.created_at AS createdAt
      FROM web_message_snapshots AS snapshots
      JOIN web_operations AS operations ON operations.id=snapshots.operation_id
      WHERE snapshots.source=? AND snapshots.session_id=? AND operations.state='accepted'
      ORDER BY snapshots.created_at DESC,snapshots.operation_id DESC
      LIMIT ?) ORDER BY createdAt ASC,id ASC
    `).all(source, sessionId, bounded) as Array<{ id: string; role: "user"; text: string; createdAt: number }>;
  }

  /** Enforce the only legal edges with an atomic expected-state predicate. */
  transitionOperation(id: string, from: OperationState, to: OperationState, now: number, errorCode: string | null = null): boolean {
    const legal = from === "received" ? to === "dispatching" || to === "failed" : from === "dispatching" && ["queued", "accepted", "failed", "delivery_unknown"].includes(to);
    if (!legal) return false;
    return this.db.query("UPDATE web_operations SET state=?,updated_at=?,error_code=? WHERE id=? AND state=?").run(to, now, errorCode, id, from).changes > 0;
  }

  /** Preserve a known created session before admitting the first prompt. */
  setOperationSession(id: string, sessionId: string, now: number, turnId: string | null = null): void {
    this.db.query("UPDATE web_operations SET session_id=?,turn_id=COALESCE(?,turn_id),updated_at=? WHERE id=? AND state='dispatching'").run(sessionId, turnId, now, id);
  }

  /** Quarantine interrupted dispatches before HTTP begins accepting writes. */
  recoverOperations(now: number): number {
    return this.db.query("UPDATE web_operations SET state='delivery_unknown',error_code='restart_after_dispatch',updated_at=? WHERE state='dispatching'").run(now).changes;
  }

  /** Determine whether a missing pepper must fail closed. */
  operationsExist(): boolean { return this.db.query("SELECT 1 FROM web_operations LIMIT 1").get() !== null; }

  /** Append a pre-filtered security/control event. */
  audit(deviceId: string, action: string, detailJson: string, now: number): void {
    this.db.query("INSERT INTO web_audit(device_id,action,detail_json,created_at) VALUES(?,?,?,?)").run(deviceId, action, detailJson, now);
  }

  /** Delete by age and count without touching legacy bridge tables. */
  cleanup(now: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM web_csrf_tokens WHERE expires_at<=? OR device_id IN (SELECT id FROM web_device_sessions WHERE revoked_at IS NOT NULL)").run(now);
      this.db.query("DELETE FROM web_device_sessions WHERE expires_at<=?").run(now);
      for (const table of ["web_logs", "web_operations", "web_message_snapshots", "web_audit"] as const) {
        const key = table === "web_message_snapshots" ? "operation_id" : "id";
        const ttl = table === "web_logs" ? 7 : 30;
        this.db.query(`DELETE FROM ${table} WHERE created_at<?`).run(now - ttl * 86400000);
        this.db.run(`DELETE FROM ${table} WHERE ${key} NOT IN (SELECT ${key} FROM ${table} ORDER BY created_at DESC,${key} DESC LIMIT 10000)`);
      }
    })();
  }
}

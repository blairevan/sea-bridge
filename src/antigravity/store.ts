import type { Database } from "bun:sqlite";

export type AntigravitySessionStatus = "idle" | "running" | "cancelling" | "failed" | "unknown";
export type AntigravityExecutionStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "incomplete"
  | "failed"
  | "unknown"
  | "not_dispatched_after_restart";
export type AntigravityApprovalStatus = "pending" | "selected" | "cancelled" | "expired" | "stale";

export interface AntigravityProjectRecord {
  id: string; name: string; rootPath: string; policyVersion: string; updatedAt: number;
}

export interface AntigravitySessionRecord {
  sessionId: string; nativeSessionId: string; sessionOrigin?: "sea_bridge" | "desktop";
  clientTarget?: "cli" | "desktop" | null; appDataDir?: string | null;
  projectId: string | null; cwd: string; title: string;
  modelId: string | null; reasoningEffort: string | null; modeId: string | null;
  status: AntigravitySessionStatus; completeHistory: boolean; snapshotGeneration: number;
  lastExecutionId?: string | null; lastExecutionEpoch?: number; lastError?: string | null;
  createdAt: number; updatedAt: number;
}

export interface AntigravityExecutionRecord {
  executionId: string; operationId: string; sessionId: string; epoch: number;
  processGeneration: number; rpcRequestId: string | null; status: AntigravityExecutionStatus;
  stopReason: string | null; errorCode: string | null; createdAt: number; updatedAt: number;
}

export interface AntigravityMessageRecord {
  id: string; sessionId: string; snapshotGeneration: number; seq: number;
  role: "user" | "assistant" | "system" | "tool"; kind: string; text: string;
  toolCallId: string | null; toolName: string | null; toolStatus: string | null;
  replayed: boolean; createdAt: number;
}

export interface AntigravityApprovalOption {
  optionId: string; name: string; kind: string;
}

export interface AntigravityApprovalRecord {
  id: string; sessionId: string; executionId: string; processGeneration: number;
  rpcRequestId: string; toolCallId: string; toolName: string; toolTitle: string;
  options: AntigravityApprovalOption[]; status: AntigravityApprovalStatus;
  selectedOptionId: string | null; decidedBy: string | null;
  createdAt: number; expiresAt: number; decidedAt: number | null;
}

const SESSION_COLUMNS = `session_id AS sessionId, native_session_id AS nativeSessionId,
  session_origin AS sessionOrigin, client_target AS clientTarget, app_data_dir AS appDataDir,
  project_id AS projectId,
  cwd, title, model_id AS modelId, reasoning_effort AS reasoningEffort, mode_id AS modeId,
  status, complete_history AS completeHistory, snapshot_generation AS snapshotGeneration,
  last_execution_id AS lastExecutionId, last_execution_epoch AS lastExecutionEpoch,
  last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt`;

const APPROVAL_COLUMNS = `id, session_id AS sessionId, execution_id AS executionId,
  process_generation AS processGeneration, rpc_request_id AS rpcRequestId,
  tool_call_id AS toolCallId, tool_name AS toolName, tool_title AS toolTitle,
  options_json AS optionsJson, status, selected_option_id AS selectedOptionId,
  decided_by AS decidedBy, created_at AS createdAt, expires_at AS expiresAt, decided_at AS decidedAt`;

/** Create Antigravity bridge persistence tables inside StateDb initialization. */
export function migrateAntigravityBridgeTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS antigravity_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
      policy_version TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS antigravity_sessions (
      session_id TEXT PRIMARY KEY, native_session_id TEXT NOT NULL UNIQUE,
      session_origin TEXT NOT NULL DEFAULT 'sea_bridge' CHECK(session_origin IN ('sea_bridge','desktop')),
      client_target TEXT CHECK(client_target IN ('cli','desktop')),
      app_data_dir TEXT,
      project_id TEXT,
      cwd TEXT NOT NULL, title TEXT NOT NULL, model_id TEXT, reasoning_effort TEXT, mode_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('idle','running','cancelling','failed','unknown')),
      complete_history INTEGER NOT NULL DEFAULT 1 CHECK(complete_history IN (0,1)),
      snapshot_generation INTEGER NOT NULL DEFAULT 1, last_execution_id TEXT,
      last_execution_epoch INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_antigravity_sessions_updated ON antigravity_sessions(updated_at DESC, session_id);
    CREATE TABLE IF NOT EXISTS antigravity_executions (
      execution_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      epoch INTEGER NOT NULL, process_generation INTEGER NOT NULL, rpc_request_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','starting','running','cancelling','completed','cancelled','incomplete','failed','unknown','not_dispatched_after_restart')),
      stop_reason TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_antigravity_executions_session ON antigravity_executions(session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS antigravity_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot_generation INTEGER NOT NULL, seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')), kind TEXT NOT NULL, text TEXT NOT NULL,
      tool_call_id TEXT, tool_name TEXT, tool_status TEXT,
      replayed INTEGER NOT NULL DEFAULT 0 CHECK(replayed IN (0,1)), created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_antigravity_messages_session ON antigravity_messages(session_id, snapshot_generation, seq);
    CREATE TABLE IF NOT EXISTS antigravity_approvals (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      process_generation INTEGER NOT NULL, rpc_request_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL, tool_title TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','selected','cancelled','expired','stale')),
      selected_option_id TEXT, decided_by TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_antigravity_approvals_session ON antigravity_approvals(session_id, status, created_at);
    CREATE TABLE IF NOT EXISTS antigravity_message_links (
      telegram_chat_id TEXT NOT NULL, telegram_message_id INTEGER NOT NULL, session_id TEXT NOT NULL,
      session_origin TEXT NOT NULL CHECK(session_origin IN ('sea_bridge','desktop')),
      event_kind TEXT NOT NULL, event_fingerprint TEXT NOT NULL UNIQUE, sent_at INTEGER NOT NULL,
      PRIMARY KEY (telegram_chat_id, telegram_message_id)
    );
    CREATE TABLE IF NOT EXISTS antigravity_telegram_state (
      key TEXT PRIMARY KEY, value_json TEXT NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS antigravity_outbox (
      event_fingerprint TEXT PRIMARY KEY, telegram_chat_id TEXT NOT NULL, session_id TEXT NOT NULL,
      event_kind TEXT NOT NULL, message_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sent','quarantined')),
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      last_error TEXT, telegram_message_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_antigravity_outbox_due ON antigravity_outbox(status, next_attempt_at, created_at);
  `);
  const cols = db.query("PRAGMA table_info(antigravity_sessions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "session_origin")) {
    db.exec("ALTER TABLE antigravity_sessions ADD COLUMN session_origin TEXT NOT NULL DEFAULT 'sea_bridge'");
  }
  if (!cols.some((c) => c.name === "client_target")) {
    db.exec("ALTER TABLE antigravity_sessions ADD COLUMN client_target TEXT CHECK(client_target IN ('cli','desktop'))");
  }
  if (!cols.some((c) => c.name === "app_data_dir")) {
    db.exec("ALTER TABLE antigravity_sessions ADD COLUMN app_data_dir TEXT");
  }
}

/** Persistence store for SeaBridge-managed Antigravity sessions, executions, messages, and approvals. */
export class AntigravityStore {
  constructor(readonly db: Database) {}

  /** Insert or update an allowed local project entry. */
  upsertProject(project: AntigravityProjectRecord): void {
    this.db.query(`
      INSERT INTO antigravity_projects(id,name,root_path,policy_version,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_path=excluded.root_path,
        policy_version=excluded.policy_version, updated_at=excluded.updated_at
    `).run(project.id, project.name, project.rootPath, project.policyVersion, project.updatedAt);
  }

  /** List all persisted allowed projects ordered by name. */
  listProjects(): AntigravityProjectRecord[] {
    return this.db.query(
      "SELECT id, name, root_path AS rootPath, policy_version AS policyVersion, updated_at AS updatedAt FROM antigravity_projects ORDER BY name ASC, id ASC"
    ).all() as AntigravityProjectRecord[];
  }

  /** Insert or update a managed Antigravity session record. */
  upsertSession(s: AntigravitySessionRecord): void {
    this.db.query(`
      INSERT INTO antigravity_sessions(
        session_id, native_session_id, session_origin, client_target, app_data_dir, project_id, cwd, title, model_id, reasoning_effort, mode_id,
        status, complete_history, snapshot_generation, last_execution_id, last_execution_epoch, last_error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_origin=excluded.session_origin,
        client_target=COALESCE(excluded.client_target, antigravity_sessions.client_target),
        app_data_dir=COALESCE(excluded.app_data_dir, antigravity_sessions.app_data_dir),
        project_id=excluded.project_id, cwd=excluded.cwd, title=excluded.title,
        model_id=excluded.model_id, reasoning_effort=excluded.reasoning_effort, mode_id=excluded.mode_id, status=excluded.status,
        complete_history=excluded.complete_history, snapshot_generation=excluded.snapshot_generation,
        last_execution_id=excluded.last_execution_id, last_execution_epoch=excluded.last_execution_epoch,
        last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(
      s.sessionId, s.nativeSessionId, s.sessionOrigin ?? "sea_bridge", s.clientTarget ?? null, s.appDataDir ?? null,
      s.projectId, s.cwd, s.title, s.modelId, s.reasoningEffort, s.modeId,
      s.status, s.completeHistory ? 1 : 0, s.snapshotGeneration, s.lastExecutionId ?? null,
      s.lastExecutionEpoch ?? 0, s.lastError ?? null, s.createdAt, s.updatedAt
    );
  }

  /** Read a single managed session by sessionId. */
  getSession(sessionId: string): AntigravitySessionRecord | null {
    const row = this.db.query(`SELECT ${SESSION_COLUMNS} FROM antigravity_sessions WHERE session_id=?`).get(sessionId) as
      | (Omit<AntigravitySessionRecord, "completeHistory"> & { completeHistory: number })
      | null;
    return row ? { ...row, completeHistory: row.completeHistory === 1 } : null;
  }

  /** List managed sessions ordered by updatedAt descending. */
  listSessions(limit = 200): AntigravitySessionRecord[] {
    const rows = this.db.query(
      `SELECT ${SESSION_COLUMNS} FROM antigravity_sessions ORDER BY updated_at DESC, session_id ASC LIMIT ?`
    ).all(limit) as Array<Omit<AntigravitySessionRecord, "completeHistory"> & { completeHistory: number }>;
    return rows.map((row) => ({ ...row, completeHistory: row.completeHistory === 1 }));
  }

  /** Insert or update an execution record. */
  upsertExecution(e: AntigravityExecutionRecord): void {
    this.db.query(`
      INSERT INTO antigravity_executions(
        execution_id, operation_id, session_id, epoch, process_generation, rpc_request_id,
        status, stop_reason, error_code, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(execution_id) DO UPDATE SET
        rpc_request_id=excluded.rpc_request_id, status=excluded.status,
        stop_reason=excluded.stop_reason, error_code=excluded.error_code, updated_at=excluded.updated_at
    `).run(
      e.executionId, e.operationId, e.sessionId, e.epoch, e.processGeneration, e.rpcRequestId,
      e.status, e.stopReason, e.errorCode, e.createdAt, e.updatedAt
    );
  }

  /** Read an execution record by executionId. */
  getExecution(executionId: string): AntigravityExecutionRecord | null {
    return this.db.query(`
      SELECT execution_id AS executionId, operation_id AS operationId, session_id AS sessionId,
        epoch, process_generation AS processGeneration, rpc_request_id AS rpcRequestId,
        status, stop_reason AS stopReason, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt
      FROM antigravity_executions WHERE execution_id=?
    `).get(executionId) as AntigravityExecutionRecord | null;
  }

  /** Append or update a projected message record for the active snapshot generation. */
  upsertMessage(m: AntigravityMessageRecord): void {
    this.db.query(`
      INSERT INTO antigravity_messages(
        id, session_id, snapshot_generation, seq, role, kind, text, tool_call_id, tool_name, tool_status, replayed, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text, tool_status=excluded.tool_status, created_at=excluded.created_at
    `).run(
      m.id, m.sessionId, m.snapshotGeneration, m.seq, m.role, m.kind, m.text,
      m.toolCallId, m.toolName, m.toolStatus, m.replayed ? 1 : 0, m.createdAt
    );
  }

  /** List messages for a session at its current snapshot generation. */
  listMessages(sessionId: string, snapshotGeneration?: number): AntigravityMessageRecord[] {
    const gen = snapshotGeneration ?? this.getSession(sessionId)?.snapshotGeneration ?? 1;
    const rows = this.db.query(`
      SELECT id, session_id AS sessionId, snapshot_generation AS snapshotGeneration, seq, role, kind, text,
        tool_call_id AS toolCallId, tool_name AS toolName, tool_status AS toolStatus, replayed, created_at AS createdAt
      FROM antigravity_messages WHERE session_id=? AND snapshot_generation=? ORDER BY seq ASC, created_at ASC
    `).all(sessionId, gen) as Array<Omit<AntigravityMessageRecord, "replayed"> & { replayed: number }>;
    return rows.map((row) => ({ ...row, replayed: row.replayed === 1 }));
  }

  /** Atomically replace a session's snapshot generation with a newly replayed message list. */
  replaceReplaySnapshot(sessionId: string, newGeneration: number, messages: AntigravityMessageRecord[], completeHistory: boolean, now: number): void {
    this.db.transaction(() => {
      for (const msg of messages) {
        this.upsertMessage({ ...msg, snapshotGeneration: newGeneration, replayed: true });
      }
      this.db.query("UPDATE antigravity_sessions SET snapshot_generation=?, complete_history=?, updated_at=? WHERE session_id=?")
        .run(newGeneration, completeHistory ? 1 : 0, now, sessionId);
      this.db.query("DELETE FROM antigravity_messages WHERE session_id=? AND snapshot_generation<>?").run(sessionId, newGeneration);
    })();
  }

  /** Insert or update an approval record. */
  upsertApproval(a: AntigravityApprovalRecord): void {
    this.db.query(`
      INSERT INTO antigravity_approvals(
        id, session_id, execution_id, process_generation, rpc_request_id,
        tool_call_id, tool_name, tool_title, options_json, status,
        selected_option_id, decided_by, created_at, expires_at, decided_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, selected_option_id=excluded.selected_option_id,
        decided_by=excluded.decided_by, decided_at=excluded.decided_at
    `).run(
      a.id, a.sessionId, a.executionId, a.processGeneration, a.rpcRequestId,
      a.toolCallId, a.toolName, a.toolTitle, JSON.stringify(a.options), a.status,
      a.selectedOptionId, a.decidedBy, a.createdAt, a.expiresAt, a.decidedAt
    );
  }

  /** Get an approval record by id. */
  getApproval(id: string): AntigravityApprovalRecord | null {
    const row = this.db.query(`SELECT ${APPROVAL_COLUMNS} FROM antigravity_approvals WHERE id=?`).get(id) as
      | (Omit<AntigravityApprovalRecord, "options"> & { optionsJson: string })
      | null;
    if (!row) return null;
    const { optionsJson, ...rest } = row;
    return { ...rest, options: JSON.parse(optionsJson) as AntigravityApprovalOption[] };
  }

  /** List pending approvals for a session. */
  listPendingApprovals(sessionId: string): AntigravityApprovalRecord[] {
    const rows = this.db.query(
      `SELECT ${APPROVAL_COLUMNS} FROM antigravity_approvals WHERE session_id=? AND status='pending' ORDER BY created_at ASC`
    ).all(sessionId) as Array<Omit<AntigravityApprovalRecord, "options"> & { optionsJson: string }>;
    return rows.map(({ optionsJson, ...rest }) => ({ ...rest, options: JSON.parse(optionsJson) as AntigravityApprovalOption[] }));
  }

  /** Recover interrupted executions and sessions on service startup. */
  recoverOnStartup(now: number): void {
    this.db.transaction(() => {
      this.db.query("UPDATE antigravity_executions SET status='not_dispatched_after_restart', error_code='restart_before_dispatch', updated_at=? WHERE status='queued'").run(now);
      this.db.query("UPDATE antigravity_executions SET status='unknown', error_code='restart_after_dispatch', updated_at=? WHERE status IN ('starting','running','cancelling')").run(now);
      this.db.query("UPDATE antigravity_sessions SET status='unknown', last_error='restart_during_execution', updated_at=? WHERE status IN ('running','cancelling')").run(now);
      this.db.query("UPDATE antigravity_approvals SET status='stale', decided_at=? WHERE status='pending'").run(now);
    })();
  }
}

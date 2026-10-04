import type { Database } from "bun:sqlite";

/** Add Web-only tables atomically; the hook permits rollback fault injection. */
export function migrateWeb(db: Database, beforeCommit?: () => void): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS web_settings(
        id INTEGER PRIMARY KEY CHECK(id=1), redaction_enabled INTEGER NOT NULL CHECK(redaction_enabled IN (0,1)), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO web_settings VALUES(1,1,1);
      CREATE TABLE IF NOT EXISTS web_device_sessions(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, session_hash TEXT NOT NULL UNIQUE,
        paired_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS web_csrf_tokens(
        device_id TEXT PRIMARY KEY REFERENCES web_device_sessions(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_operations(
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','send')),
        source TEXT NOT NULL CHECK(source IN ('codex','dsh')), device_id TEXT NOT NULL,
        target_id TEXT, project_id TEXT, model_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('received','dispatching','queued','accepted','failed','delivery_unknown')),
        session_id TEXT, turn_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_message_snapshots(
        operation_id TEXT PRIMARY KEY REFERENCES web_operations(id) ON DELETE CASCADE,
        source TEXT NOT NULL, session_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, event TEXT NOT NULL,
        fields_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, action TEXT NOT NULL,
        detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS web_operations_time ON web_operations(created_at);
      CREATE INDEX IF NOT EXISTS web_logs_time ON web_logs(created_at);
      INSERT OR IGNORE INTO web_schema_migrations VALUES(1);
    `);
    if (!db.query("SELECT version FROM web_schema_migrations WHERE version=2").get()) {
      db.exec(`
        CREATE TABLE web_admin_account(
          id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL,
          password_hash TEXT NOT NULL, revision INTEGER NOT NULL);
        UPDATE web_device_sessions SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE revoked_at IS NULL;
        INSERT INTO web_schema_migrations VALUES(2);
      `);
    }
    beforeCommit?.();
  })();
}

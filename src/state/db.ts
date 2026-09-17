import { Database } from "bun:sqlite";

export class StateDb {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id INTEGER PRIMARY KEY,
        received_at INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        processed_at INTEGER,
        error_code TEXT
      );

      CREATE TABLE IF NOT EXISTS observed_sessions (
        session_id TEXT PRIMARY KEY,
        turn_id TEXT,
        last_event TEXT NOT NULL,
        activity_state TEXT NOT NULL CHECK(activity_state IN ('active','idle','unknown')),
        last_seen_at INTEGER NOT NULL,
        transcript_path TEXT,
        cwd TEXT
      );

      CREATE TABLE IF NOT EXISTS desktop_hook_events (
        event_hash TEXT PRIMARY KEY,
        hook_event_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        received_at INTEGER NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        payload_redacted_json TEXT
      );

      CREATE TABLE IF NOT EXISTS continuation_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','claimed','consumed','cancelled','expired')),
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        consumed_at INTEGER,
        claimed_by_turn_id TEXT,
        telegram_update_id INTEGER,
        UNIQUE(telegram_update_id)
      );
      CREATE INDEX IF NOT EXISTS idx_continuation_pending ON continuation_queue(session_id, status, created_at);

      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        event_hash TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','selected','delivered','expired','stale')),
        decision TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        callback_token_hash TEXT UNIQUE
      );

      CREATE TABLE IF NOT EXISTS capabilities (
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider TEXT,
        contract_fingerprint TEXT,
        reason TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS desktop_message_links (
        telegram_chat_id TEXT NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        event_kind TEXT NOT NULL,
        event_fingerprint TEXT NOT NULL UNIQUE,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (telegram_chat_id, telegram_message_id)
      );

      CREATE TABLE IF NOT EXISTS telegram_thread_deliveries (
        telegram_update_id INTEGER PRIMARY KEY,
        reply_to_message_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received','dispatching','delivered','failed','delivery_unknown')),
        queue_exit_code INTEGER,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS desktop_observer_cursors (
        thread_id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        schema_fingerprint TEXT NOT NULL,
        last_event_fingerprint TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close(false);
  }
}

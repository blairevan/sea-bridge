import { Database } from "bun:sqlite";

function migrateDshBridgeTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dsh_message_links (
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      event_fingerprint TEXT NOT NULL UNIQUE,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (telegram_chat_id, telegram_message_id)
    );

    CREATE TABLE IF NOT EXISTS dsh_deliveries (
      telegram_update_id INTEGER PRIMARY KEY,
      reply_to_message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('received','dispatching','delivered','failed','delivery_unknown')),
      error_code TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS dsh_observer_state (
      session_id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL,
      contract_fingerprint TEXT NOT NULL,
      last_event_fingerprint TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dsh_notification_outbox (
      event_fingerprint TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      message_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sent')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      telegram_message_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dsh_notification_due
      ON dsh_notification_outbox(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS dsh_callback_tokens (
      token_hash TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','consumed','expired')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dsh_callback_expiry
      ON dsh_callback_tokens(status, expires_at);

    CREATE TABLE IF NOT EXISTS dsh_creation_requests (
      telegram_update_id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      model_id TEXT,
      prompt_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('received','dispatching','accepted','acknowledged','failed','delivery_unknown')),
      session_id TEXT,
      turn_id TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dsh_created_sessions (
      session_id TEXT PRIMARY KEY,
      creation_update_id INTEGER NOT NULL UNIQUE,
      baseline_pending INTEGER NOT NULL DEFAULT 1 CHECK(baseline_pending IN (0,1)),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dsh_pending_new_session_prompts (
      telegram_chat_id TEXT NOT NULL,
      prompt_message_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','consumed','expired')),
      consumed_at INTEGER,
      PRIMARY KEY (telegram_chat_id, prompt_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dsh_pending_prompt_expiry
      ON dsh_pending_new_session_prompts(status, expires_at);
  `);
}

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

      CREATE TABLE IF NOT EXISTS codex_creation_requests (
        telegram_update_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('dispatching','started','delivery_unknown')),
        thread_id TEXT,
        turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
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

      CREATE TABLE IF NOT EXISTS desktop_codex_catalog_meta (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
        codex_home_identity TEXT NOT NULL,
        generation INTEGER NOT NULL,
        full_reconciled_at INTEGER,
        completeness TEXT NOT NULL CHECK(completeness IN ('full','partial')),
        observed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS desktop_codex_catalog (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        rollout_path TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        recency_at_ms INTEGER,
        creation_client_kind TEXT NOT NULL,
        creation_client_evidence TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        missing_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_desktop_codex_catalog_updated
        ON desktop_codex_catalog(updated_at_ms DESC, thread_id);

      CREATE TABLE IF NOT EXISTS desktop_observer_meta (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
        schema_version INTEGER NOT NULL,
        schema_initialized_at INTEGER NOT NULL,
        codex_home_identity TEXT NOT NULL,
        bootstrap_started_at INTEGER,
        bootstrap_initial_pass_completed_at INTEGER,
        bootstrap_catalog_generation INTEGER
      );

      CREATE TABLE IF NOT EXISTS desktop_observer_state (
        thread_id TEXT PRIMARY KEY,
        bootstrap_member INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_member IN (0,1)),
        baseline_state TEXT NOT NULL CHECK(baseline_state IN ('pending','monitoring','deferred')),
        anchor_turn_id TEXT,
        monitoring_started_at INTEGER,
        monitor_from_at INTEGER NOT NULL,
        next_history_reconcile_at INTEGER NOT NULL,
        last_reconciled_at INTEGER,
        first_discovered_at INTEGER,
        last_recency_at_ms INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_desktop_observer_due
        ON desktop_observer_state(baseline_state, next_history_reconcile_at);

      CREATE TABLE IF NOT EXISTS desktop_turn_observations (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        last_status TEXT NOT NULL,
        terminal_kind TEXT,
        content_state TEXT NOT NULL CHECK(content_state IN ('not_applicable','pending','ready','confirmed_empty','timeout_unconfirmed')),
        disposition TEXT NOT NULL CHECK(disposition IN ('monitoring','baseline_suppressed','already_known','notification_enqueued')),
        final_text_hash TEXT,
        terminal_first_observed_at INTEGER,
        settle_deadline_at INTEGER,
        first_observed_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_desktop_turn_observation_pending
        ON desktop_turn_observations(disposition, content_state, last_observed_at);

      CREATE TABLE IF NOT EXISTS desktop_notification_outbox (
        event_fingerprint TEXT PRIMARY KEY,
        telegram_chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        message_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sent')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        telegram_message_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_desktop_notification_due
        ON desktop_notification_outbox(status, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS user_preferences (
        telegram_chat_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (telegram_chat_id, key)
      );

      CREATE TABLE IF NOT EXISTS pending_new_thread_prompts (
        telegram_chat_id TEXT NOT NULL,
        prompt_message_id INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','consumed','expired')),
        consumed_at INTEGER,
        PRIMARY KEY (telegram_chat_id, prompt_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_new_thread_expiry
        ON pending_new_thread_prompts(status, expires_at);
    `);

    migrateDshBridgeTables(this.db);
  }

  close(): void {
    this.db.close(false);
  }
}

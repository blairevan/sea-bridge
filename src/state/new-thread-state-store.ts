import type { StateDb } from "./db.ts";

const DEFAULT_MODEL_KEY = "default_model";

export interface PendingNewThreadPrompt {
  chatId: string;
  promptMessageId: number;
  projectId: string;
  projectName: string;
  cwd: string;
  expiresAt: number;
}

interface PendingRow {
  telegram_chat_id: string;
  prompt_message_id: number;
  project_id: string;
  project_name: string;
  cwd: string;
  expires_at: number;
}

function mapPending(row: PendingRow): PendingNewThreadPrompt {
  return {
    chatId: row.telegram_chat_id,
    promptMessageId: Number(row.prompt_message_id),
    projectId: row.project_id,
    projectName: row.project_name,
    cwd: row.cwd,
    expiresAt: Number(row.expires_at),
  };
}

export class NewThreadStateStore {
  constructor(private readonly state: StateDb) {}

  getDefaultModel(chatId: string): string | null {
    const row = this.state.db.query(
      "SELECT value FROM user_preferences WHERE telegram_chat_id=? AND key=?",
    ).get(chatId, DEFAULT_MODEL_KEY) as { value: string } | null;
    return row?.value ?? null;
  }

  setDefaultModel(chatId: string, model: string): void {
    this.state.db.query(
      `INSERT INTO user_preferences(telegram_chat_id,key,value,updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(telegram_chat_id,key)
       DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).run(chatId, DEFAULT_MODEL_KEY, model, Date.now());
  }

  clearDefaultModel(chatId: string): void {
    this.state.db.query(
      "DELETE FROM user_preferences WHERE telegram_chat_id=? AND key=?",
    ).run(chatId, DEFAULT_MODEL_KEY);
  }

  createPendingPrompt(input: {
    chatId: string;
    promptMessageId: number;
    projectId: string;
    projectName: string;
    cwd: string;
    expiresAt: number;
  }): void {
    const now = Date.now();
    this.state.db.query(
      `INSERT INTO pending_new_thread_prompts(
         telegram_chat_id,prompt_message_id,project_id,project_name,cwd,created_at,expires_at,status,consumed_at
       ) VALUES (?,?,?,?,?,?,?,'pending',NULL)
       ON CONFLICT(telegram_chat_id,prompt_message_id)
       DO UPDATE SET
         project_id=excluded.project_id,
         project_name=excluded.project_name,
         cwd=excluded.cwd,
         created_at=excluded.created_at,
         expires_at=excluded.expires_at,
         status='pending',
         consumed_at=NULL`,
    ).run(
      input.chatId,
      input.promptMessageId,
      input.projectId,
      input.projectName,
      input.cwd,
      now,
      input.expiresAt,
    );
  }

  getPendingPrompt(chatId: string, promptMessageId: number): PendingNewThreadPrompt | null {
    const row = this.state.db.query(
      `SELECT telegram_chat_id,prompt_message_id,project_id,project_name,cwd,expires_at
       FROM pending_new_thread_prompts
       WHERE telegram_chat_id=? AND prompt_message_id=? AND status='pending'`,
    ).get(chatId, promptMessageId) as PendingRow | null;
    return row ? mapPending(row) : null;
  }

  consumePendingPrompt(chatId: string, promptMessageId: number, now = Date.now()): PendingNewThreadPrompt | null {
    const consume = this.state.db.transaction(() => {
      const row = this.state.db.query(
        `SELECT telegram_chat_id,prompt_message_id,project_id,project_name,cwd,expires_at
         FROM pending_new_thread_prompts
         WHERE telegram_chat_id=? AND prompt_message_id=? AND status='pending'`,
      ).get(chatId, promptMessageId) as PendingRow | null;
      if (!row) return null;

      if (Number(row.expires_at) <= now) {
        this.state.db.query(
          `UPDATE pending_new_thread_prompts
           SET status='expired'
           WHERE telegram_chat_id=? AND prompt_message_id=? AND status='pending'`,
        ).run(chatId, promptMessageId);
        return null;
      }

      const result = this.state.db.query(
        `UPDATE pending_new_thread_prompts
         SET status='consumed',consumed_at=?
         WHERE telegram_chat_id=? AND prompt_message_id=? AND status='pending'`,
      ).run(now, chatId, promptMessageId);
      return result.changes === 1 ? mapPending(row) : null;
    });
    return consume();
  }

  cleanupExpired(now = Date.now()): number {
    const expired = this.state.db.query(
      `UPDATE pending_new_thread_prompts
       SET status='expired'
       WHERE status='pending' AND expires_at<=?`,
    ).run(now);
    this.state.db.query(
      `DELETE FROM pending_new_thread_prompts
       WHERE status IN ('consumed','expired') AND COALESCE(consumed_at,expires_at)<?`,
    ).run(now - 24 * 60 * 60_000);
    return Number(expired.changes);
  }
}

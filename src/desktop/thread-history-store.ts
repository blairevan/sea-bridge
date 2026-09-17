import { Database } from "bun:sqlite";

export interface DesktopThreadTurn {
  threadId: string;
  turnId: string;
  ordinal: number;
  status: string;
  completedAtMs: number | null;
  finalText: string | null;
}

export interface ThreadHistoryReader {
  latestOrdinal(threadId: string): number;
  latestOrdinals(threadIds: string[]): Map<string, number>;
  listTurnsAfter(threadId: string, ordinal: number): DesktopThreadTurn[];
}

interface AgentMessagePayload {
  text?: unknown;
}

function finalText(itemJson: string | null): string | null {
  if (!itemJson) return null;
  try {
    const item = JSON.parse(itemJson) as AgentMessagePayload;
    return typeof item.text === "string" && item.text.trim() ? item.text : null;
  } catch {
    return null;
  }
}

export class ThreadHistoryStore implements ThreadHistoryReader {
  constructor(private readonly path: string) {}

  latestOrdinal(threadId: string): number {
    const db = new Database(this.path, { readonly: true, strict: true });
    try {
      const row = db.query("SELECT COALESCE(MAX(COALESCE(rollout_end_ordinal, rollout_ordinal)), 0) AS ordinal FROM thread_turns WHERE thread_id=?").get(threadId) as { ordinal: number };
      return Number(row.ordinal);
    } finally {
      db.close(false);
    }
  }

  latestOrdinals(threadIds: string[]): Map<string, number> {
    if (threadIds.length === 0) return new Map();
    const db = new Database(this.path, { readonly: true, strict: true });
    try {
      const placeholders = threadIds.map(() => "?").join(",");
      const rows = db.query(`SELECT thread_id,COALESCE(MAX(COALESCE(rollout_end_ordinal, rollout_ordinal)), 0) AS ordinal FROM thread_turns WHERE thread_id IN (${placeholders}) GROUP BY thread_id`).all(...threadIds) as Array<{ thread_id: string; ordinal: number }>;
      return new Map(rows.map((row) => [row.thread_id, Number(row.ordinal)]));
    } finally {
      db.close(false);
    }
  }

  listTurnsAfter(threadId: string, ordinal: number): DesktopThreadTurn[] {
    const db = new Database(this.path, { readonly: true, strict: true });
    try {
      const rows = db.query(`
        SELECT turns.thread_id,turns.turn_id,COALESCE(turns.rollout_end_ordinal, turns.rollout_ordinal) AS observation_ordinal,turns.status,turns.completed_at,items.item_json
        FROM thread_turns AS turns
        LEFT JOIN thread_items AS items ON items.thread_id=turns.thread_id AND items.item_id=turns.final_agent_item_id
        WHERE turns.thread_id=? AND COALESCE(turns.rollout_end_ordinal, turns.rollout_ordinal)>?
        ORDER BY observation_ordinal ASC
      `).all(threadId, ordinal) as Array<{
        thread_id: string;
        turn_id: string;
        observation_ordinal: number;
        status: string;
        completed_at: number | null;
        item_json: string | null;
      }>;
      return rows.map((row) => ({
        threadId: row.thread_id,
        turnId: row.turn_id,
        ordinal: Number(row.observation_ordinal),
        status: row.status,
        completedAtMs: row.completed_at == null ? null : Number(row.completed_at),
        finalText: finalText(row.item_json),
      }));
    } finally {
      db.close(false);
    }
  }
}

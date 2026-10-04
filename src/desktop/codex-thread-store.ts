import { Database } from "bun:sqlite";

export interface CodexThread {
  id: string;
  rolloutPath: string;
  title: string;
  updatedAtMs: number;
}

export interface CodexThreadReader {
  listActive(): CodexThread[];
  getThread?(threadId: string): CodexThread | null;
}

/** Normalize a native title without persisting changes back into Codex. */
function threadTitle(row: { id: string; name: string | null; title: string | null }): string {
  return row.name?.trim() || row.title?.trim() || `未命名会话 · ${row.id.slice(-8)}`;
}

/** Read native user-facing thread metadata while retaining diagnostic point lookups. */
export class CodexThreadStore implements CodexThreadReader {
  /** Accept the existing Codex state database location. */
  constructor(private readonly path: string) {}

  /** Resolve any known thread for diagnostics with the same display-title fallback. */
  getThread(threadId: string): CodexThread | null {
    const db = new Database(this.path, { strict: true });
    try {
      const row = db.query(
        "SELECT id,rollout_path,name,title,recency_at_ms FROM threads WHERE id=?",
      ).get(threadId) as { id: string; rollout_path: string; name: string | null; title: string | null; recency_at_ms: number } | null;
      if (!row) return null;
      return {
        id: row.id,
        rolloutPath: row.rollout_path,
        title: threadTitle(row),
        updatedAtMs: Number(row.recency_at_ms),
      };
    } finally {
      db.close(false);
    }
  }

  /** List nonarchived ordinary threads, excluding internal subagent records by provenance. */
  listActive(): CodexThread[] {
    const db = new Database(this.path, { strict: true });
    try {
      const rows = db.query(
        "SELECT id,rollout_path,name,title,recency_at_ms FROM threads WHERE archived=0 AND COALESCE(thread_source, '')<>'subagent' ORDER BY recency_at_ms ASC",
      ).all() as Array<{ id: string; rollout_path: string; name: string | null; title: string | null; recency_at_ms: number }>;
      return rows.map((row) => ({
        id: row.id,
        rolloutPath: row.rollout_path,
        title: threadTitle(row),
        updatedAtMs: Number(row.recency_at_ms),
      }));
    } finally {
      db.close(false);
    }
  }
}

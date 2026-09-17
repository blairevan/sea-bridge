import { Database } from "bun:sqlite";

export interface CodexThread {
  id: string;
  rolloutPath: string;
  title: string;
  updatedAtMs: number;
}

export interface CodexThreadReader {
  listActive(): CodexThread[];
}

export class CodexThreadStore implements CodexThreadReader {
  constructor(private readonly path: string) {}

  listActive(): CodexThread[] {
    const db = new Database(this.path, { readonly: true, strict: true });
    try {
      const rows = db.query(
        "SELECT id,rollout_path,COALESCE(NULLIF(name, ''), title) AS title,recency_at_ms FROM threads WHERE archived=0 ORDER BY recency_at_ms ASC",
      ).all() as Array<{ id: string; rollout_path: string; title: string; recency_at_ms: number }>;
      return rows.map((row) => ({
        id: row.id,
        rolloutPath: row.rollout_path,
        title: row.title,
        updatedAtMs: Number(row.recency_at_ms),
      }));
    } finally {
      db.close(false);
    }
  }
}

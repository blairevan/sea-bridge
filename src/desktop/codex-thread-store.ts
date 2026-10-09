import { Database } from "bun:sqlite";
import { classifyCreationClient, type CreationClient } from "./codex-provenance.ts";

export interface CodexThread {
  id: string;
  rolloutPath: string | null;
  title: string;
  updatedAtMs: number;
  creationClient?: CreationClient;
}

export interface CodexThreadReader {
  listActive(): CodexThread[];
  getThread?(threadId: string): CodexThread | null;
}

/** Normalize a native title without persisting changes back into Codex. */
function threadTitle(row: { id: string; name: string | null; title: string | null }): string {
  let title = row.name?.trim() || row.title?.trim();
  if (title) {
    const trimmed = title.trimStart();
    if (trimmed.startsWith("# Files mentioned by the user:")) {
      const marker = "## My request:";
      const split = trimmed.indexOf(marker);
      if (split >= 0) {
        const body = trimmed.slice(split + marker.length).replace(/<\/?image\b[^>]*>/g, "").trim();
        if (body) {
          title = body.split("\n")[0]?.trim() || body;
        } else {
          const header = trimmed.slice(0, split);
          const first = /^## ([^\n:]+):/m.exec(header)?.[1]?.trim();
          title = first ? `[图片] ${first}` : "图片会话";
        }
      }
    }
  }
  return title || `未命名会话 · ${row.id.slice(-8)}`;
}

/** Fixed projections cover old schemas without accepting dynamically supplied column names. */
const PROVENANCE_PROFILES = [
  "NULL AS source, NULL AS originator",
  "source, NULL AS originator",
  "NULL AS source, originator",
  "source, originator",
] as const;

/** Read native user-facing thread metadata while retaining diagnostic point lookups. */
export class CodexThreadStore implements CodexThreadReader {
  /** Accept the existing Codex state database location. */
  constructor(private readonly path: string) {}

  /** Probe only the two optional columns and select one of four fixed SQL profiles. */
  private projection(db: Database): string {
    const columns = db.query("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const profile = (names.has("source") ? 1 : 0) + (names.has("originator") ? 2 : 0);
    return PROVENANCE_PROFILES[profile] ?? PROVENANCE_PROFILES[0];
  }

  /** Retry once if the schema changes between capability probing and query preparation. */
  private read<T>(db: Database, query: (projection: string) => T): T {
    try { return query(this.projection(db)); }
    catch (error) {
      if (!(error instanceof Error) || !/no such column|schema.*changed/i.test(error.message)) throw error;
      return query(this.projection(db));
    }
  }

  /** Resolve any known thread for diagnostics with the same display-title fallback. */
  getThread(threadId: string): CodexThread | null {
    const db = new Database(this.path, { strict: true, readonly: true });
    try {
      const row = this.read(db, (projection) => db.query(
        `SELECT id,rollout_path,name,title,recency_at_ms,${projection} FROM threads WHERE id=?`,
      ).get(threadId)) as { source: unknown; originator: unknown; id: string; rollout_path: string; name: string | null; title: string | null; recency_at_ms: number } | null;
      if (!row) return null;
      return {
        id: row.id,
        rolloutPath: row.rollout_path,
        title: threadTitle(row),
        updatedAtMs: Number(row.recency_at_ms),
        creationClient: classifyCreationClient(row.source, row.originator),
      };
    } finally {
      db.close(false);
    }
  }

  /** List nonarchived ordinary threads, excluding internal subagent records by provenance. */
  listActive(): CodexThread[] {
    const db = new Database(this.path, { strict: true, readonly: true });
    try {
      const rows = this.read(db, (projection) => db.query(
        `SELECT id,rollout_path,name,title,recency_at_ms,${projection} FROM threads WHERE archived=0 AND COALESCE(thread_source, '')<>'subagent' ORDER BY recency_at_ms ASC`,
      ).all()) as Array<{ source: unknown; originator: unknown; id: string; rollout_path: string; name: string | null; title: string | null; recency_at_ms: number }>;
      return rows.map((row) => ({
        id: row.id,
        rolloutPath: row.rollout_path,
        title: threadTitle(row),
        updatedAtMs: Number(row.recency_at_ms),
        creationClient: classifyCreationClient(row.source, row.originator),
      }));
    } finally {
      db.close(false);
    }
  }
}

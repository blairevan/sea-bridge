import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import type { WebMessage } from "../web/sources/types.ts";

/** A failed queue read is different from a confirmed empty queue. */
export interface CodexQueueSnapshot { available: boolean; messages: WebMessage[]; }

export interface CodexQueueMetadata {
  id: string; threadId: string; clientId: string | null; createdAt: number; updatedAt: number; queueOrder: number;
}
export interface CodexQueueMetadataSnapshot {
  available: boolean; items: CodexQueueMetadata[]; truncated: boolean; errorCode?: string;
}

/** Extract only supported native text input, ignoring non-user queue payloads. */
function inputText(raw: string): string | null {
  const payload: unknown = JSON.parse(raw);
  if (!payload || typeof payload !== "object" || !("UserInput" in payload)) return null;
  const input = payload.UserInput;
  if (!input || typeof input !== "object" || !("content" in input) || !Array.isArray(input.content)) return null;
  const text = input.content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") return [];
    return [part.text];
  }).join("\n");
  return text.trim() ? text : null;
}

/** Read the Desktop-owned queue without creating, migrating or changing its database. */
export class CodexQueueStore {
  /** Accept a trusted server-side path, never a browser-provided database location. */
  constructor(private readonly path: string) {}

  /** Read bounded lifecycle metadata only, including payload-corrupt rows and a pagination safety flag. */
  readMetadata(limit = 500): CodexQueueMetadataSnapshot {
    let db: Database | null = null;
    try {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("queue_limit_invalid");
      const file = lstatSync(this.path);
      if (!file.isFile() || file.isSymbolicLink()) return { available: false, items: [], truncated: false, errorCode: "queue_path_unsafe" };
      db = new Database(this.path, { readonly: true, strict: true });
      db.exec("PRAGMA busy_timeout=100");
      const rows = db.query(`SELECT id,thread_id,created_at_ms,updated_at_ms,queue_order,
        CASE WHEN length(payload_json)<=262144 AND json_valid(payload_json) THEN json_extract(payload_json,'$.UserInput.client_id') END AS client_id
        FROM queued_items ORDER BY thread_id,queue_order,id LIMIT ?`).all(limit + 1) as Array<{
          id: string; thread_id: string; created_at_ms: number; updated_at_ms: number; queue_order: number; client_id: unknown;
        }>;
      if (rows.some((row) => typeof row.id !== "string" || typeof row.thread_id !== "string" ||
          !Number.isSafeInteger(row.created_at_ms) || !Number.isSafeInteger(row.updated_at_ms) || !Number.isSafeInteger(row.queue_order))) {
        return { available: false, items: [], truncated: false, errorCode: "queue_schema_invalid" };
      }
      const items = rows.slice(0, limit).map((row) => ({ id: row.id, threadId: row.thread_id,
        createdAt: row.created_at_ms, updatedAt: row.updated_at_ms, queueOrder: row.queue_order,
        clientId: typeof row.client_id === "string" && /^[0-9a-f-]{36}$/i.test(row.client_id) ? row.client_id : null }));
      return { available: true, items, truncated: rows.length > limit };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      return { available: false, items: [], truncated: false,
        errorCode: code === "ENOENT" ? "queue_missing" : typeof code === "string" && /^SQLITE_[A-Z_]+$/.test(code) ? code : "queue_read_failed" };
    } finally { db?.close(false); }
  }

  /** Return this thread's queued inputs in native queue order; errors preserve uncertainty. */
  read(threadId: string): CodexQueueSnapshot {
    let db: Database | null = null;
    try {
      const file = lstatSync(this.path);
      if (!file.isFile() || file.isSymbolicLink()) return { available: false, messages: [] };
      db = new Database(this.path, { readonly: true, strict: true });
      const rows = db.query(`SELECT id,payload_json,created_at_ms FROM queued_items
        WHERE thread_id=? AND length(payload_json)<=262144 ORDER BY queue_order,id LIMIT 100`).all(threadId) as Array<{
        id: string; payload_json: string; created_at_ms: number;
      }>;
      const messages: WebMessage[] = [];
      for (const row of rows) {
        const text = inputText(row.payload_json);
        if (text) messages.push({ id: `queued-${row.id}`, role: "user", text, createdAt: row.created_at_ms, deliveryState: "queued" });
      }
      return { available: true, messages };
    } catch { return { available: false, messages: [] }; }
    finally { db?.close(false); }
  }
}

import type { WebStore } from "./store.ts";

/** Shared read-only operation shape for Web and historical Telegram bridge deliveries. */
interface RecordItem {
  id: string; source: string; transport: string; kind: string; state: string;
  sessionId: string | null; errorCode: string | null; createdAt: number;
}

/** Read a bounded merged diagnostic page; Telegram tables keep their original semantics. */
export function operationRecords(store: WebStore, input: {
  source: string | null; session: string | null; state: string | null; from: number; to: number; limit: number; offset: number;
}): { items: RecordItem[]; cursor: string | null } {
  const count = Math.min(10100, input.offset + input.limit + 1);
  const records = store.db.query("SELECT id,source,'web' AS transport,kind,state,session_id AS sessionId,error_code AS errorCode,created_at AS createdAt FROM web_operations ORDER BY created_at DESC LIMIT ?").all(count) as RecordItem[];
  for (const [table, source, target] of [["telegram_thread_deliveries", "codex", "thread_id"], ["dsh_deliveries", "dsh", "session_id"]] as const) {
    if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const rows = store.db.query(`SELECT telegram_update_id AS id,status AS state,${target} AS sessionId,error_code AS errorCode,created_at AS createdAt FROM ${table} ORDER BY created_at DESC LIMIT ?`).all(count) as Array<{ id: number; state: string; sessionId: string; errorCode: string | null; createdAt: number }>;
    records.push(...rows.map((row) => ({ ...row, id: `telegram-${source}-${row.id}`, source, transport: "telegram", kind: "send", state: row.state === "delivered" ? source === "codex" ? "queued" : "accepted" : row.state })));
  }
  const filtered = records.filter((row) => (!input.source || row.source === input.source) && (!input.session || row.sessionId === input.session) && (!input.state || row.state === input.state) && row.createdAt >= input.from && row.createdAt <= input.to).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return { items: filtered.slice(input.offset, input.offset + input.limit), cursor: filtered.length > input.offset + input.limit ? String(input.offset + input.limit) : null };
}

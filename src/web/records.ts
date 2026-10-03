import type { WebSource } from "./sources/types.ts";
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
  const count = Math.min(10101, input.offset + input.limit + 1);
  const records: RecordItem[] = [];

  // Push filters into each provider-scoped query before applying the per-table bound. Filtering
  // after LIMIT can otherwise hide an older matching row behind unrelated newer operations.
  {
    const where = ["created_at>=?", "created_at<=?"];
    const params: Array<string | number> = [input.from, input.to];
    if (input.source) { where.push("source=?"); params.push(input.source); }
    if (input.session) { where.push("session_id=?"); params.push(input.session); }
    if (input.state) { where.push("state=?"); params.push(input.state); }
    const sql = `SELECT id,source,'web' AS transport,kind,state,session_id AS sessionId,error_code AS errorCode,created_at AS createdAt
      FROM web_operations WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id COLLATE BINARY ASC LIMIT ?`;
    records.push(...store.db.query(sql).all(...params, count) as RecordItem[]);
  }

  for (const [table, source, target] of [["telegram_thread_deliveries", "codex", "thread_id"], ["dsh_deliveries", "dsh", "session_id"]] as const) {
    if (input.source && input.source !== source) continue;
    if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    let storedState: string | null = input.state;
    if (input.state === "queued") storedState = source === "codex" ? "delivered" : "__no_match__";
    else if (input.state === "accepted") storedState = source === "dsh" ? "delivered" : "__no_match__";
    if (storedState === "__no_match__") continue;
    const where = ["created_at>=?", "created_at<=?"];
    const params: Array<string | number> = [input.from, input.to];
    if (input.session) { where.push(`${target}=?`); params.push(input.session); }
    if (storedState) { where.push("status=?"); params.push(storedState); }
    const sql = `SELECT telegram_update_id AS id,status AS state,${target} AS sessionId,error_code AS errorCode,created_at AS createdAt
      FROM ${table} WHERE ${where.join(" AND ")} ORDER BY created_at DESC,CAST(telegram_update_id AS TEXT) COLLATE BINARY ASC LIMIT ?`;
    const rows = store.db.query(sql).all(...params, count) as Array<{ id: number; state: string; sessionId: string; errorCode: string | null; createdAt: number }>;
    records.push(...rows.map((row) => ({ ...row, id: `telegram-${source}-${row.id}`, source, transport: "telegram", kind: "send",
      state: row.state === "delivered" ? source === "codex" ? "queued" : "accepted" : row.state })));
  }

  // dsh creation requests have durable provider-scoped state; expose them without inferring any
  // equivalent historical Codex creation record that the current schema does not persist.
  if ((!input.source || input.source === "dsh") &&
      store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_creation_requests'").get()) {
    const where = ["created_at>=?", "created_at<=?"];
    const params: Array<string | number> = [input.from, input.to];
    if (input.session) { where.push("session_id=?"); params.push(input.session); }
    if (input.state === "queued") {
      where.push("0");
    } else if (input.state === "accepted") {
      where.push("status IN ('accepted','acknowledged')");
    } else if (input.state) {
      where.push("status=?"); params.push(input.state);
    }
    const rows = store.db.query(`SELECT telegram_update_id AS id,status AS state,session_id AS sessionId,error_code AS errorCode,created_at AS createdAt
      FROM dsh_creation_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC,CAST(telegram_update_id AS TEXT) COLLATE BINARY ASC LIMIT ?`)
      .all(...params, count) as Array<{ id: number; state: string; sessionId: string | null; errorCode: string | null; createdAt: number }>;
    records.push(...rows.map((row) => ({ ...row, id: `telegram-dsh-create-${row.id}`, source: "dsh", transport: "telegram", kind: "create",
      state: row.state === "acknowledged" ? "accepted" : row.state })));
  }

  records.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items: records.slice(input.offset, input.offset + input.limit), cursor: records.length > input.offset + input.limit ? String(input.offset + input.limit) : null };
}

/** Resolve source-owned titles without making diagnostic records depend on source availability. */
export async function withSessionTitles(page: { items: RecordItem[]; cursor: string | null }, sources: Partial<Record<"codex" | "dsh", Pick<WebSource, "sessions">>>): Promise<{ items: Array<RecordItem & { sessionTitle: string | null }>; cursor: string | null }> {
  const names = [...new Set(page.items.filter((item) => item.sessionId).map((item) => item.source))].filter((name): name is "codex" | "dsh" => name === "codex" || name === "dsh");
  const results = await Promise.allSettled(names.map(async (name) => ({ name, sessions: await sources[name]?.sessions() ?? [] })));
  const titles = new Map<string, string>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const session of result.value.sessions) titles.set(JSON.stringify([result.value.name, session.id]), session.title);
  }
  return { ...page, items: page.items.map((item) => ({ ...item, sessionTitle: titles.get(JSON.stringify([item.source, item.sessionId])) ?? null })) };
}

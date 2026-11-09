import type { WebSession, WebSource } from "./sources/types.ts";

interface ListSelection {
  source: string | null;
  sessionId: string | null;
  query: string;
  creationClient: string | null;
  activity: string | null;
  offset: number;
  limit: number;
}

/** Refresh exact IDs after global ordering, never a source-relative approximation of the visible page. */
async function refreshPage(sources: Partial<Record<"codex" | "dsh" | "antigravity", WebSource>>, page: WebSession[]): Promise<{ items: WebSession[]; failed: boolean }> {
  const results = await Promise.all(Object.entries(sources).map(async ([name, source]) => {
    const ids = page.filter((item) => item.source === name).map((item) => item.id);
    if (!source || !ids.length) return { name, items: [] as WebSession[], failed: false };
    try { return { name, items: await source.sessions({ sessionIds: ids, limit: ids.length }), failed: false }; }
    catch { return { name, items: [] as WebSession[], failed: true }; }
  }));
  const fresh = new Map(results.flatMap((result) => result.items.map((item) => [`${item.source}:${item.id}`, item] as const)));
  return { failed: results.some((result) => result.failed), items: page.map((item) => fresh.get(`${item.source}:${item.id}`) ?? {
    ...item, state: "unknown", stateConfirmation: { phase: "unavailable", reason: "read_unavailable" },
  }) };
}

/** Scan bounded batches before activity filtering; the cursor tracks scanned candidates, including nonmatches. */
export async function listWebSessions(sources: Partial<Record<"codex" | "dsh" | "antigravity", WebSource>>, selection: ListSelection) {
  const results = await Promise.allSettled(Object.entries(sources)
    .filter(([name]) => (!selection.source || name === selection.source) && (!selection.creationClient || name === "codex" || name === "antigravity"))
    .map(async ([, source]) => source?.sessions({ limit: 0 }) ?? []));
  const candidates = results.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .filter((item) => item.title.toLowerCase().includes(selection.query.toLowerCase())
      && (!selection.sessionId || item.id === selection.sessionId)
      && (!selection.creationClient || ((item.source === "codex" || item.source === "antigravity") && (item.creationClient?.kind ?? "unknown") === selection.creationClient)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  let partial = results.some((result) => result.status === "rejected");
  let cursor = selection.offset;
  let scanned = 0;
  const items: WebSession[] = [];
  const budget = selection.activity ? 100 : selection.limit;
  while (cursor < candidates.length && scanned < budget && items.length < selection.limit) {
    const size = Math.min(selection.activity ? 30 : selection.limit, budget - scanned);
    const refreshed = await refreshPage(sources, candidates.slice(cursor, cursor + size));
    partial ||= refreshed.failed;
    for (const item of refreshed.items) {
      cursor++; scanned++;
      if (!selection.activity || item.state === selection.activity) items.push(item);
      if (items.length >= selection.limit) break;
    }
  }
  const scanLimited = Boolean(selection.activity && scanned >= budget && cursor < candidates.length && items.length < selection.limit);
  return { items, cursor: cursor < candidates.length ? String(cursor) : null, partial: partial || scanLimited, scanLimited };
}

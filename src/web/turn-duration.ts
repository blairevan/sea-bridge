/** Minimal timing metadata from records inside the bounded history read. */
export interface TurnTimingRecord { offset: number; kind: "start" | "end" | "context" | "reply"; turnId: string | null; time: number | null; }

/** Ignore malformed records and retain no message or tool content. */
export function parseTurnTiming(line: string, offset: number): TurnTimingRecord | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!row.payload || typeof row.payload !== "object") return null;
  const payload = row.payload as Record<string, unknown>;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  const time = Number.isFinite(timestamp) ? timestamp : null;
  const kind = row.type === "event_msg" && payload.type === "task_started" ? "start"
    : row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(String(payload.type)) ? "end"
    : row.type === "turn_context" ? "context"
    : row.type === "response_item" && payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer" ? "reply" : null;
  return kind ? { offset, kind, turnId, time } : null;
}

/** Associate replies with native turn IDs; missing or reversed timestamps never fabricate duration. */
export function replyDurations(records: TurnTimingRecord[]): Map<number, number> {
  const starts = new Map<string, number>(); const ends = new Map<string, number>();
  const replies = new Map<number, string>(); let current: string | null = null;
  for (const record of records.sort((a, b) => a.offset - b.offset)) {
    if (record.kind === "start" || record.kind === "context") current = record.turnId;
    if (record.kind === "start" && record.turnId && record.time !== null) starts.set(record.turnId, record.time);
    if (record.kind === "end" && record.turnId) {
      if (record.time !== null) ends.set(record.turnId, record.time);
      if (current === record.turnId) current = null;
    }
    if (record.kind === "reply" && current) replies.set(record.offset, current);
  }
  const result = new Map<number, number>();
  for (const [offset, turn] of replies) {
    const start = starts.get(turn); const end = ends.get(turn);
    if (start !== undefined && end !== undefined && end >= start) result.set(offset, end - start);
  }
  return result;
}

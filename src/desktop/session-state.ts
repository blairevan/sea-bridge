import { createHash } from "node:crypto";
import type { StateDb } from "../state/db.ts";
import type { CodexHookEvent } from "./hook-types.ts";

export type SessionActivityState = "active" | "idle" | "unknown";

export interface ObservedSession {
  sessionId: string;
  turnId: string | null;
  lastEvent: string;
  activityState: SessionActivityState;
  lastSeenAt: number;
  transcriptPath: string | null;
  cwd: string | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

export function hookEventHash(event: CodexHookEvent): string {
  return createHash("sha256").update(stableJson(event)).digest("hex");
}

function activityForEvent(eventName: string): SessionActivityState {
  if (eventName === "Stop" || eventName === "SessionEnd" || eventName === "Interrupt") return "idle";
  if (["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "PreCompact", "PostCompact"].includes(eventName)) return "active";
  return "unknown";
}

export class SessionStateStore {
  constructor(private readonly state: StateDb) {}

  recordEvent(event: CodexHookEvent, redactedPayload: string | null = null): { eventHash: string; duplicate: boolean } {
    const eventHash = hookEventHash(event);
    const now = Date.now();
    const existing = this.state.db.query("SELECT event_hash FROM desktop_hook_events WHERE event_hash=?").get(eventHash);
    const duplicate = Boolean(existing);
    if (!duplicate) {
      this.state.db.query(`INSERT INTO desktop_hook_events(event_hash,hook_event_name,session_id,turn_id,received_at,stale,payload_redacted_json) VALUES (?,?,?,?,?,0,?)`)
        .run(eventHash, event.hook_event_name, event.session_id, event.turn_id ?? null, now, redactedPayload);
    }
    return { eventHash, duplicate };
  }

  observeEvent(event: CodexHookEvent): void {
    const activity = activityForEvent(event.hook_event_name);
    const now = Date.now();
    this.state.db.query(`
      INSERT INTO observed_sessions(session_id,turn_id,last_event,activity_state,last_seen_at,transcript_path,cwd)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
        turn_id=excluded.turn_id,
        last_event=excluded.last_event,
        activity_state=CASE WHEN excluded.activity_state='unknown' THEN observed_sessions.activity_state ELSE excluded.activity_state END,
        last_seen_at=excluded.last_seen_at,
        transcript_path=COALESCE(excluded.transcript_path, observed_sessions.transcript_path),
        cwd=COALESCE(excluded.cwd, observed_sessions.cwd)
    `).run(
      event.session_id,
      event.turn_id ?? null,
      event.hook_event_name,
      activity,
      now,
      event.transcript_path ?? null,
      event.cwd ?? null,
    );

  }

  markEventStale(eventHash: string): void {
    this.state.db.query("UPDATE desktop_hook_events SET stale=1 WHERE event_hash=?").run(eventHash);
  }

  getMostRecentlyActive(ttlMs: number): ObservedSession | null {
    const minSeen = Date.now() - ttlMs;
    const row = this.state.db.query(`
      SELECT session_id,turn_id,last_event,activity_state,last_seen_at,transcript_path,cwd
      FROM observed_sessions
      WHERE activity_state='active' AND last_seen_at>=?
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(minSeen) as any;
    return row ? this.fromRow(row) : null;
  }

  setActivity(sessionId: string, state: SessionActivityState, turnId?: string | null): void {
    this.state.db.query(`
      UPDATE observed_sessions SET activity_state=?, turn_id=COALESCE(?, turn_id), last_seen_at=? WHERE session_id=?
    `).run(state, turnId ?? null, Date.now(), sessionId);
  }

  getMostRecent(): ObservedSession | null {
    const row = this.state.db.query(`
      SELECT session_id,turn_id,last_event,activity_state,last_seen_at,transcript_path,cwd
      FROM observed_sessions ORDER BY last_seen_at DESC LIMIT 1
    `).get() as any;
    return row ? this.fromRow(row) : null;
  }

  getById(sessionId: string): ObservedSession | null {
    const row = this.state.db.query(`
      SELECT session_id,turn_id,last_event,activity_state,last_seen_at,transcript_path,cwd
      FROM observed_sessions WHERE session_id=?
    `).get(sessionId) as any;
    return row ? this.fromRow(row) : null;
  }

  private fromRow(row: any): ObservedSession {
    return {
      sessionId: row.session_id,
      turnId: row.turn_id ?? null,
      lastEvent: row.last_event,
      activityState: row.activity_state,
      lastSeenAt: Number(row.last_seen_at),
      transcriptPath: row.transcript_path ?? null,
      cwd: row.cwd ?? null,
    };
  }
}

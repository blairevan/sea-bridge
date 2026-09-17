import type { StateDb } from "../state/db.ts";
import type { ContinuationQueue } from "../state/continuation-queue.ts";
import type { ObservedSession, SessionStateStore } from "./session-state.ts";

export type DesktopContinuationResult =
  | { status: "queued"; sessionId: string; queueId: string }
  | { status: "unavailable"; code: "UNAVAILABLE_DESKTOP_CONTINUATION" | "UNAVAILABLE_DESKTOP_IDLE_WAKE"; reason: string };

export interface DesktopObservedStatus {
  session: ObservedSession | null;
  continuationQueueLength: number;
  capabilities: Array<{
    name: string;
    status: string;
    provider: string | null;
    reason: string | null;
    updatedAt: number;
  }>;
}

export class DesktopSameSessionAdapter {
  constructor(
    private readonly state: StateDb,
    private readonly sessions: SessionStateStore,
    private readonly queue: ContinuationQueue,
    private readonly activeSessionTtlMs: number,
  ) {}

  enqueueContinuation(text: string, telegramUpdateId: number): DesktopContinuationResult {
    const active = this.sessions.getMostRecentlyActive(this.activeSessionTtlMs);
    if (!active) {
      const latest = this.sessions.getMostRecent();
      if (latest?.activityState === "idle") {
        return {
          status: "unavailable",
          code: "UNAVAILABLE_DESKTOP_IDLE_WAKE",
          reason: `Desktop session ${latest.sessionId} is idle; no verified idle-wake provider is available`,
        };
      }
      return {
        status: "unavailable",
        code: "UNAVAILABLE_DESKTOP_CONTINUATION",
        reason: "No fresh active Desktop session is currently proven by Hook observations",
      };
    }

    const item = this.queue.enqueue(active.sessionId, text, telegramUpdateId);
    return { status: "queued", sessionId: active.sessionId, queueId: item.id };
  }

  getObservedStatus(): DesktopObservedStatus {
    const session = this.sessions.getMostRecent();
    const capabilities = this.state.db.query(
      "SELECT name,status,provider,reason,updated_at FROM capabilities ORDER BY name",
    ).all() as Array<{ name: string; status: string; provider: string | null; reason: string | null; updated_at: number }>;

    return {
      session,
      continuationQueueLength: session ? this.queue.pendingCount(session.sessionId) : 0,
      capabilities: capabilities.map((row) => ({
        name: row.name,
        status: row.status,
        provider: row.provider,
        reason: row.reason,
        updatedAt: Number(row.updated_at),
      })),
    };
  }

  answerUserInput(): { status: "unavailable"; code: "UNAVAILABLE_DESKTOP_USER_INPUT" } {
    return { status: "unavailable", code: "UNAVAILABLE_DESKTOP_USER_INPUT" };
  }

  interrupt(): { status: "unavailable"; code: "UNAVAILABLE_DESKTOP_INTERRUPT" } {
    return { status: "unavailable", code: "UNAVAILABLE_DESKTOP_INTERRUPT" };
  }
}

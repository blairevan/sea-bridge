import { randomUUID } from "node:crypto";
import type { StateDb } from "./db.ts";

export interface ContinuationItem {
  id: string;
  sessionId: string;
  text: string;
  status: "pending" | "claimed" | "consumed" | "cancelled" | "expired";
  createdAt: number;
  claimedByTurnId?: string;
}

export class ContinuationQueue {
  constructor(private readonly state: StateDb) {}

  enqueue(sessionId: string, text: string, telegramUpdateId?: number): ContinuationItem {
    const item: ContinuationItem = { id: randomUUID(), sessionId, text, status: "pending", createdAt: Date.now() };
    this.state.db.query(`INSERT INTO continuation_queue(id,session_id,text,status,created_at,telegram_update_id) VALUES (?,?,?,?,?,?)`)
      .run(item.id, sessionId, text, item.status, item.createdAt, telegramUpdateId ?? null);
    return item;
  }

  claimNext(sessionId: string, turnId: string): ContinuationItem | null {
    const tx = this.state.db.transaction(() => {
      const row = this.state.db.query(`SELECT id,session_id,text,status,created_at FROM continuation_queue WHERE session_id=? AND status='pending' ORDER BY created_at,id LIMIT 1`).get(sessionId) as any;
      if (!row) return null;
      const now = Date.now();
      const result = this.state.db.query(`UPDATE continuation_queue SET status='claimed',claimed_at=?,claimed_by_turn_id=? WHERE id=? AND status='pending'`).run(now, turnId, row.id);
      if (result.changes !== 1) return null;
      return { id: row.id, sessionId: row.session_id, text: row.text, status: "claimed", createdAt: row.created_at, claimedByTurnId: turnId } satisfies ContinuationItem;
    });
    return tx();
  }

  markConsumed(id: string): boolean {
    const result = this.state.db.query(`UPDATE continuation_queue SET status='consumed',consumed_at=? WHERE id=? AND status='claimed'`).run(Date.now(), id);
    return result.changes === 1;
  }

  releaseClaim(id: string): boolean {
    const result = this.state.db.query(`UPDATE continuation_queue SET status='pending',claimed_at=NULL,claimed_by_turn_id=NULL WHERE id=? AND status='claimed'`).run(id);
    return result.changes === 1;
  }

  pendingCount(sessionId: string): number {
    const row = this.state.db.query(`SELECT COUNT(*) AS c FROM continuation_queue WHERE session_id=? AND status='pending'`).get(sessionId) as { c: number };
    return Number(row.c);
  }
}

import type { StateDb } from "./db.ts";

export type DesktopMessageEventKind = "started" | "waiting_for_input" | "completed" | "failed" | "interrupted" | "reply_prompt" | "thread_created";
export type DeliveryStatus = "received" | "dispatching" | "delivered" | "failed" | "delivery_unknown";
export type TerminalDeliveryStatus = Exclude<DeliveryStatus, "received" | "dispatching">;

export interface DesktopMessageLink {
  chatId: string;
  messageId: number;
  threadId: string;
  turnId: string | null;
  eventKind: DesktopMessageEventKind;
  eventFingerprint: string;
}

export interface TelegramThreadDelivery {
  updateId: number;
  threadId: string;
  status: DeliveryStatus;
  exitCode: number | null;
  errorCode: string | null;
}

export interface DesktopObserverCursor {
  threadId: string;
  rolloutPath: string;
  byteOffset: number;
  schemaFingerprint: string;
  lastEventFingerprint: string | null;
}

export interface PendingDesktopNotification {
  eventFingerprint: string;
  chatId: string;
  threadId: string;
  turnId: string;
  eventKind: DesktopMessageEventKind;
  text: string;
  attemptCount: number;
  nextAttemptAt: number;
}

type DesktopNotificationInput = Omit<PendingDesktopNotification, "attemptCount" | "nextAttemptAt">;

export class DesktopMessageStore {
  constructor(private readonly state: StateDb) {}

  /** Adds a redacted Telegram notification to the durable delivery queue once. */
  enqueueNotification(notification: DesktopNotificationInput, now = Date.now()): boolean {
    const result = this.state.db.query(
      `INSERT OR IGNORE INTO desktop_notification_outbox(
        event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,status,
        attempt_count,next_attempt_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'pending',0,?,?,?)`,
    ).run(
      notification.eventFingerprint,
      notification.chatId,
      notification.threadId,
      notification.turnId,
      notification.eventKind,
      notification.text,
      now,
      now,
      now,
    );
    return result.changes === 1;
  }

  /** Returns due, unsent notifications in creation order. */
  listPendingNotifications(now = Date.now(), limit = 50): PendingDesktopNotification[] {
    const rows = this.state.db.query(
      `SELECT event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,attempt_count,next_attempt_at
       FROM desktop_notification_outbox
       WHERE status='pending' AND next_attempt_at<=?
       ORDER BY created_at,event_fingerprint LIMIT ?`,
    ).all(now, limit) as Array<{
      event_fingerprint: string;
      telegram_chat_id: string;
      thread_id: string;
      turn_id: string;
      event_kind: DesktopMessageEventKind;
      message_text: string;
      attempt_count: number;
      next_attempt_at: number;
    }>;
    return rows.map((row) => ({
      eventFingerprint: row.event_fingerprint,
      chatId: row.telegram_chat_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventKind: row.event_kind,
      text: row.message_text,
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: Number(row.next_attempt_at),
    }));
  }

  /** Records a delivery failure and schedules its next retry. */
  markNotificationFailed(eventFingerprint: string, error: string, retryAt: number, now = Date.now()): number {
    this.state.db.query(
      `UPDATE desktop_notification_outbox
       SET attempt_count=attempt_count+1,next_attempt_at=?,last_error=?,updated_at=?
       WHERE event_fingerprint=? AND status='pending'`,
    ).run(retryAt, error.slice(0, 500), now, eventFingerprint);
    const row = this.state.db.query(
      "SELECT attempt_count FROM desktop_notification_outbox WHERE event_fingerprint=?",
    ).get(eventFingerprint) as { attempt_count: number } | null;
    return Number(row?.attempt_count ?? 0);
  }

  /** Atomically stores the reply link and marks its notification as sent. */
  completeNotification(eventFingerprint: string, messageId: number, now = Date.now()): boolean {
    const complete = this.state.db.transaction(() => {
      const row = this.state.db.query(
        `SELECT telegram_chat_id,thread_id,turn_id,event_kind
         FROM desktop_notification_outbox WHERE event_fingerprint=? AND status='pending'`,
      ).get(eventFingerprint) as {
        telegram_chat_id: string;
        thread_id: string;
        turn_id: string;
        event_kind: DesktopMessageEventKind;
      } | null;
      if (!row) return false;
      this.state.db.query(
        `INSERT INTO desktop_message_links(
          telegram_chat_id,telegram_message_id,thread_id,turn_id,event_kind,event_fingerprint,sent_at
        ) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(telegram_chat_id,telegram_message_id) DO UPDATE SET
          event_kind=excluded.event_kind,event_fingerprint=excluded.event_fingerprint
        WHERE desktop_message_links.thread_id=excluded.thread_id
          AND desktop_message_links.turn_id=excluded.turn_id
          AND desktop_message_links.event_kind='interrupted'
          AND excluded.event_kind='completed'`,
      ).run(row.telegram_chat_id, messageId, row.thread_id, row.turn_id, row.event_kind, eventFingerprint, now);
      const result = this.state.db.query(
        `UPDATE desktop_notification_outbox
         SET status='sent',message_text='',telegram_message_id=?,last_error=NULL,updated_at=?
         WHERE event_fingerprint=? AND status='pending'`,
      ).run(messageId, now, eventFingerprint);
      return result.changes === 1;
    });
    return complete();
  }

  /** Finds the original interrupted message within the exact chat, thread and turn. */
  findSentInterruptedMessage(chatId: string, threadId: string, turnId: string): number | null {
    const row = this.state.db.query(`
      SELECT telegram_message_id FROM desktop_message_links
      WHERE telegram_chat_id=? AND thread_id=? AND turn_id=? AND event_kind='interrupted'
      ORDER BY telegram_message_id DESC LIMIT 1
    `).get(chatId, threadId, turnId) as { telegram_message_id: number } | null;
    return row == null ? null : Number(row.telegram_message_id);
  }

  link(link: DesktopMessageLink): boolean {
    const result = this.state.db.query(
      "INSERT OR IGNORE INTO desktop_message_links(telegram_chat_id,telegram_message_id,thread_id,turn_id,event_kind,event_fingerprint,sent_at) VALUES (?,?,?,?,?,?,?)",
    ).run(link.chatId, link.messageId, link.threadId, link.turnId, link.eventKind, link.eventFingerprint, Date.now());
    return result.changes === 1;
  }

  findLink(chatId: string, messageId: number): DesktopMessageLink | null {
    const row = this.state.db.query(
      "SELECT telegram_chat_id,telegram_message_id,thread_id,turn_id,event_kind,event_fingerprint FROM desktop_message_links WHERE telegram_chat_id=? AND telegram_message_id=?",
    ).get(chatId, messageId) as {
      telegram_chat_id: string;
      telegram_message_id: number;
      thread_id: string;
      turn_id: string | null;
      event_kind: DesktopMessageEventKind;
      event_fingerprint: string;
    } | null;
    if (!row) return null;
    return {
      chatId: row.telegram_chat_id,
      messageId: row.telegram_message_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventKind: row.event_kind,
      eventFingerprint: row.event_fingerprint,
    };
  }

  findLatestLink(chatId: string): DesktopMessageLink | null {
    const row = this.state.db.query(
      "SELECT telegram_chat_id,telegram_message_id,thread_id,turn_id,event_kind,event_fingerprint FROM desktop_message_links WHERE telegram_chat_id=? ORDER BY sent_at DESC, telegram_message_id DESC LIMIT 1",
    ).get(chatId) as {
      telegram_chat_id: string;
      telegram_message_id: number;
      thread_id: string;
      turn_id: string | null;
      event_kind: DesktopMessageEventKind;
      event_fingerprint: string;
    } | null;
    if (!row) return null;
    return {
      chatId: row.telegram_chat_id,
      messageId: row.telegram_message_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      eventKind: row.event_kind,
      eventFingerprint: row.event_fingerprint,
    };
  }

  hasEventFingerprint(eventFingerprint: string): boolean {
    const row = this.state.db.query(
      "SELECT 1 AS found FROM desktop_message_links WHERE event_fingerprint=?",
    ).get(eventFingerprint) as { found: number } | null;
    return row?.found === 1;
  }

  registerCreatedThread(threadId: string): boolean {
    const result = this.state.db.query(
      "INSERT OR IGNORE INTO desktop_observer_cursors(thread_id,rollout_path,byte_offset,schema_fingerprint,last_event_fingerprint,updated_at) VALUES (?, '', 0, 'sea-bridge-created-pending-v1', NULL, ?)",
    ).run(threadId, Date.now());
    return result.changes === 1;
  }

  getCursor(threadId: string): DesktopObserverCursor | null {
    const row = this.state.db.query(
      "SELECT thread_id,rollout_path,byte_offset,schema_fingerprint,last_event_fingerprint FROM desktop_observer_cursors WHERE thread_id=?",
    ).get(threadId) as {
      thread_id: string;
      rollout_path: string;
      byte_offset: number;
      schema_fingerprint: string;
      last_event_fingerprint: string | null;
    } | null;
    if (!row) return null;
    return {
      threadId: row.thread_id,
      rolloutPath: row.rollout_path,
      byteOffset: Number(row.byte_offset),
      schemaFingerprint: row.schema_fingerprint,
      lastEventFingerprint: row.last_event_fingerprint,
    };
  }

  saveCursor(cursor: DesktopObserverCursor): void {
    this.state.db.query(
      "INSERT INTO desktop_observer_cursors(thread_id,rollout_path,byte_offset,schema_fingerprint,last_event_fingerprint,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET rollout_path=excluded.rollout_path,byte_offset=excluded.byte_offset,schema_fingerprint=excluded.schema_fingerprint,last_event_fingerprint=excluded.last_event_fingerprint,updated_at=excluded.updated_at",
    ).run(cursor.threadId, cursor.rolloutPath, cursor.byteOffset, cursor.schemaFingerprint, cursor.lastEventFingerprint, Date.now());
  }

  beginDelivery(updateId: number, replyToMessageId: number, threadId: string, textHash: string): "new" | "duplicate" {
    const result = this.state.db.query(
      "INSERT OR IGNORE INTO telegram_thread_deliveries(telegram_update_id,reply_to_message_id,thread_id,text_hash,status,created_at) VALUES (?,?,?,?,?,?)",
    ).run(updateId, replyToMessageId, threadId, textHash, "received", Date.now());
    return result.changes === 1 ? "new" : "duplicate";
  }

  markDispatching(updateId: number): boolean {
    const result = this.state.db.query(
      "UPDATE telegram_thread_deliveries SET status='dispatching' WHERE telegram_update_id=? AND status='received'",
    ).run(updateId);
    return result.changes === 1;
  }

  finishDelivery(updateId: number, status: TerminalDeliveryStatus, exitCode: number | null = null, errorCode: string | null = null): boolean {
    const result = this.state.db.query(
      "UPDATE telegram_thread_deliveries SET status=?,queue_exit_code=?,error_code=?,completed_at=? WHERE telegram_update_id=? AND status IN ('received','dispatching')",
    ).run(status, exitCode, errorCode, Date.now(), updateId);
    return result.changes === 1;
  }

  getDelivery(updateId: number): TelegramThreadDelivery | null {
    const row = this.state.db.query(
      "SELECT telegram_update_id,thread_id,status,queue_exit_code,error_code FROM telegram_thread_deliveries WHERE telegram_update_id=?",
    ).get(updateId) as {
      telegram_update_id: number;
      thread_id: string;
      status: DeliveryStatus;
      queue_exit_code: number | null;
      error_code: string | null;
    } | null;
    if (!row) return null;
    return {
      updateId: row.telegram_update_id,
      threadId: row.thread_id,
      status: row.status,
      exitCode: row.queue_exit_code,
      errorCode: row.error_code,
    };
  }
}

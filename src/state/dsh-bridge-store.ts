import { createHash } from "node:crypto";
import type { StateDb } from "./db.ts";

const DSH_DEFAULT_MODEL_KEY = "dsh.default_model";

export type DshDeliveryStatus =
  | "received"
  | "dispatching"
  | "delivered"
  | "failed"
  | "delivery_unknown";

export type DshTerminalDeliveryStatus = Exclude<DshDeliveryStatus, "received" | "dispatching">;

export type DshCreationStatus =
  | "received"
  | "dispatching"
  | "accepted"
  | "acknowledged"
  | "failed"
  | "delivery_unknown";

export interface DshDelivery {
  updateId: number;
  replyToMessageId: number;
  sessionId: string;
  textHash: string;
  status: DshDeliveryStatus;
  errorCode: string | null;
}

export interface DshCreationRequest {
  updateId: number;
  projectId: string;
  modelId: string | null;
  promptHash: string;
  status: DshCreationStatus;
  sessionId: string | null;
  turnId: string | null;
  errorCode: string | null;
}

export interface DshMessageLink {
  chatId: string;
  messageId: number;
  sessionId: string;
  eventKind: string;
  eventFingerprint: string;
}

export interface DshObserverState {
  sessionId: string;
  cursor: number;
  contractFingerprint: string;
  lastEventFingerprint: string | null;
}

export interface DshCreatedSession {
  sessionId: string;
  creationUpdateId: number;
  baselinePending: boolean;
}

export interface PendingDshNotification {
  eventFingerprint: string;
  chatId: string;
  sessionId: string;
  eventKind: string;
  text: string;
  attemptCount: number;
  nextAttemptAt: number;
}

export interface PendingDshNewSessionPrompt {
  chatId: string;
  promptMessageId: number;
  projectId: string;
  expiresAt: number;
}

export interface ConsumedDshCallback {
  action: string;
  payload: Record<string, unknown>;
}

type DshNotificationInput = Omit<PendingDshNotification, "attemptCount" | "nextAttemptAt">;

const LEGAL_CREATION_TRANSITIONS: Readonly<Record<DshCreationStatus, readonly DshCreationStatus[]>> = {
  received: ["dispatching", "failed"],
  dispatching: ["accepted", "failed", "delivery_unknown"],
  accepted: ["acknowledged"],
  acknowledged: [],
  failed: [],
  delivery_unknown: [],
};

function callbackHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function assertNonEmpty(value: string, name: string): void {
  if (!value) throw new Error(`${name} must not be empty`);
}

export class DshBridgeStore {
  constructor(private readonly state: StateDb) {}

  claimDelivery(
    updateId: number,
    replyToMessageId: number,
    sessionId: string,
    textHash: string,
    now = Date.now(),
  ): "new" | "duplicate" {
    const result = this.state.db.query(
      `INSERT OR IGNORE INTO dsh_deliveries(
        telegram_update_id,reply_to_message_id,session_id,text_hash,status,created_at
      ) VALUES (?,?,?,?, 'received', ?)`,
    ).run(updateId, replyToMessageId, sessionId, textHash, now);
    return result.changes === 1 ? "new" : "duplicate";
  }

  markDeliveryDispatching(updateId: number): boolean {
    const result = this.state.db.query(
      "UPDATE dsh_deliveries SET status='dispatching' WHERE telegram_update_id=? AND status='received'",
    ).run(updateId);
    return result.changes === 1;
  }

  finishDelivery(
    updateId: number,
    status: DshTerminalDeliveryStatus,
    errorCode: string | null = null,
    now = Date.now(),
  ): boolean {
    const result = this.state.db.query(
      `UPDATE dsh_deliveries
       SET status=?,error_code=?,completed_at=?
       WHERE telegram_update_id=? AND status IN ('received','dispatching')`,
    ).run(status, errorCode, now, updateId);
    return result.changes === 1;
  }

  recoverInterruptedWrites(now = Date.now()): { deliveries: number; creations: number } {
    const deliveries = this.state.db.query(
      `UPDATE dsh_deliveries
       SET status='delivery_unknown',error_code='process_restart_after_dispatch',completed_at=?
       WHERE status='dispatching'`,
    ).run(now).changes;
    const creations = this.state.db.query(
      `UPDATE dsh_creation_requests
       SET status='delivery_unknown',error_code='process_restart_after_dispatch',updated_at=?
       WHERE status='dispatching'`,
    ).run(now).changes;
    return { deliveries: Number(deliveries), creations: Number(creations) };
  }

  getDelivery(updateId: number): DshDelivery | null {
    const row = this.state.db.query(
      `SELECT telegram_update_id,reply_to_message_id,session_id,text_hash,status,error_code
       FROM dsh_deliveries WHERE telegram_update_id=?`,
    ).get(updateId) as {
      telegram_update_id: number;
      reply_to_message_id: number;
      session_id: string;
      text_hash: string;
      status: DshDeliveryStatus;
      error_code: string | null;
    } | null;
    if (!row) return null;
    return {
      updateId: Number(row.telegram_update_id),
      replyToMessageId: Number(row.reply_to_message_id),
      sessionId: row.session_id,
      textHash: row.text_hash,
      status: row.status,
      errorCode: row.error_code,
    };
  }

  beginCreation(
    updateId: number,
    projectId: string,
    modelId: string | null,
    promptHash: string,
    now = Date.now(),
  ): "new" | "duplicate" {
    const result = this.state.db.query(
      `INSERT OR IGNORE INTO dsh_creation_requests(
        telegram_update_id,project_id,model_id,prompt_hash,status,created_at,updated_at
      ) VALUES (?,?,?,?, 'received', ?, ?)`,
    ).run(updateId, projectId, modelId, promptHash, now, now);
    return result.changes === 1 ? "new" : "duplicate";
  }

  transitionCreation(
    updateId: number,
    expectedStatus: DshCreationStatus,
    nextStatus: DshCreationStatus,
    detail: {
      sessionId?: string;
      turnId?: string;
      errorCode?: string;
    } = {},
    now = Date.now(),
  ): boolean {
    if (!LEGAL_CREATION_TRANSITIONS[expectedStatus].includes(nextStatus)) {
      throw new Error(`illegal dsh creation transition: ${expectedStatus} -> ${nextStatus}`);
    }

    const transition = this.state.db.transaction(() => {
      const row = this.state.db.query(
        "SELECT status,session_id,turn_id,error_code FROM dsh_creation_requests WHERE telegram_update_id=?",
      ).get(updateId) as {
        status: DshCreationStatus;
        session_id: string | null;
        turn_id: string | null;
        error_code: string | null;
      } | null;
      if (!row || row.status !== expectedStatus) return false;

      const sessionId = detail.sessionId ?? row.session_id;
      const turnId = detail.turnId ?? row.turn_id;
      const errorCode = detail.errorCode ?? row.error_code;
      const result = this.state.db.query(
        `UPDATE dsh_creation_requests
         SET status=?,session_id=?,turn_id=?,error_code=?,updated_at=?
         WHERE telegram_update_id=? AND status=?`,
      ).run(nextStatus, sessionId, turnId, errorCode, now, updateId, expectedStatus);
      return result.changes === 1;
    });
    return transition();
  }

  getCreation(updateId: number): DshCreationRequest | null {
    const row = this.state.db.query(
      `SELECT telegram_update_id,project_id,model_id,prompt_hash,status,session_id,turn_id,error_code
       FROM dsh_creation_requests WHERE telegram_update_id=?`,
    ).get(updateId) as {
      telegram_update_id: number;
      project_id: string;
      model_id: string | null;
      prompt_hash: string;
      status: DshCreationStatus;
      session_id: string | null;
      turn_id: string | null;
      error_code: string | null;
    } | null;
    if (!row) return null;
    return {
      updateId: Number(row.telegram_update_id),
      projectId: row.project_id,
      modelId: row.model_id,
      promptHash: row.prompt_hash,
      status: row.status,
      sessionId: row.session_id,
      turnId: row.turn_id,
      errorCode: row.error_code,
    };
  }

  getDefaultModel(chatId: string): string | null {
    const row = this.state.db.query(
      "SELECT value FROM user_preferences WHERE telegram_chat_id=? AND key=?",
    ).get(chatId, DSH_DEFAULT_MODEL_KEY) as { value: string } | null;
    return row?.value ?? null;
  }

  setDefaultModel(chatId: string, modelId: string, now = Date.now()): void {
    this.state.db.query(
      `INSERT INTO user_preferences(telegram_chat_id,key,value,updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(telegram_chat_id,key)
       DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).run(chatId, DSH_DEFAULT_MODEL_KEY, modelId, now);
  }

  clearDefaultModel(chatId: string): void {
    this.state.db.query(
      "DELETE FROM user_preferences WHERE telegram_chat_id=? AND key=?",
    ).run(chatId, DSH_DEFAULT_MODEL_KEY);
  }

  putCallback(input: {
    token: string;
    chatId: string;
    action: string;
    payload: Record<string, unknown>;
    expiresAt: number;
  }, now = Date.now()): void {
    assertNonEmpty(input.token, "callback token");
    assertNonEmpty(input.chatId, "callback chat");
    assertNonEmpty(input.action, "callback action");
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
      throw new Error("callback expiry must be in the future");
    }
    this.state.db.query(
      `INSERT INTO dsh_callback_tokens(
        token_hash,telegram_chat_id,action,payload_json,status,created_at,expires_at
      ) VALUES (?,?,?,?, 'pending', ?, ?)`,
    ).run(
      callbackHash(input.token),
      input.chatId,
      input.action,
      JSON.stringify(input.payload),
      now,
      input.expiresAt,
    );
  }

  consumeCallback(token: string, chatId: string, now = Date.now()): ConsumedDshCallback | null {
    const consume = this.state.db.transaction(() => {
      const tokenHash = callbackHash(token);
      const row = this.state.db.query(
        `SELECT telegram_chat_id,action,payload_json,status,expires_at
         FROM dsh_callback_tokens WHERE token_hash=?`,
      ).get(tokenHash) as {
        telegram_chat_id: string;
        action: string;
        payload_json: string;
        status: "pending" | "consumed" | "expired";
        expires_at: number;
      } | null;
      if (!row || row.status !== "pending") return null;
      if (row.telegram_chat_id !== chatId) return null;
      if (Number(row.expires_at) <= now) {
        this.state.db.query(
          "UPDATE dsh_callback_tokens SET status='expired' WHERE token_hash=? AND status='pending'",
        ).run(tokenHash);
        return null;
      }

      const result = this.state.db.query(
        `UPDATE dsh_callback_tokens
         SET status='consumed',consumed_at=?
         WHERE token_hash=? AND status='pending'`,
      ).run(now, tokenHash);
      if (result.changes !== 1) return null;

      const payload = JSON.parse(row.payload_json) as unknown;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("invalid dsh callback payload");
      }
      return {
        action: row.action,
        payload: payload as Record<string, unknown>,
      };
    });
    return consume();
  }

  expireCallback(token: string, now = Date.now()): boolean {
    const result = this.state.db.query(
      `UPDATE dsh_callback_tokens
       SET status='expired',expires_at=MIN(expires_at,?)
       WHERE token_hash=? AND status='pending'`,
    ).run(now, callbackHash(token));
    return result.changes === 1;
  }

  getCallbackStatus(token: string): "pending" | "consumed" | "expired" | null {
    const row = this.state.db.query(
      "SELECT status FROM dsh_callback_tokens WHERE token_hash=?",
    ).get(callbackHash(token)) as { status: "pending" | "consumed" | "expired" } | null;
    return row?.status ?? null;
  }

  enqueueNotification(
    notification: DshNotificationInput,
    now = Date.now(),
    createdAt = now,
  ): boolean {
    const result = this.state.db.query(
      `INSERT OR IGNORE INTO dsh_notification_outbox(
        event_fingerprint,telegram_chat_id,session_id,event_kind,message_text,status,
        attempt_count,next_attempt_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,'pending',0,?,?,?)`,
    ).run(
      notification.eventFingerprint,
      notification.chatId,
      notification.sessionId,
      notification.eventKind,
      notification.text,
      now,
      createdAt,
      now,
    );
    return result.changes === 1;
  }

  listPendingNotifications(now = Date.now(), limit = 50): PendingDshNotification[] {
    const rows = this.state.db.query(
      `SELECT current.event_fingerprint,current.telegram_chat_id,current.session_id,current.event_kind,
              current.message_text,current.attempt_count,current.next_attempt_at
       FROM dsh_notification_outbox AS current
       WHERE current.status='pending' AND current.next_attempt_at<=?
         AND NOT EXISTS (
           SELECT 1 FROM dsh_notification_outbox AS prior
           WHERE prior.status='pending'
             AND prior.telegram_chat_id=current.telegram_chat_id
             AND prior.session_id=current.session_id
             AND prior.next_attempt_at>?
             AND (
               prior.created_at < current.created_at OR
               (prior.created_at=current.created_at AND prior.event_fingerprint < current.event_fingerprint)
             )
         )
       ORDER BY current.created_at,current.event_fingerprint LIMIT ?`,
    ).all(now, now, limit) as Array<{
      event_fingerprint: string;
      telegram_chat_id: string;
      session_id: string;
      event_kind: string;
      message_text: string;
      attempt_count: number;
      next_attempt_at: number;
    }>;
    return rows.map((row) => ({
      eventFingerprint: row.event_fingerprint,
      chatId: row.telegram_chat_id,
      sessionId: row.session_id,
      eventKind: row.event_kind,
      text: row.message_text,
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: Number(row.next_attempt_at),
    }));
  }

  markNotificationFailed(
    eventFingerprint: string,
    errorCode: string,
    retryAt: number,
    now = Date.now(),
  ): number {
    this.state.db.query(
      `UPDATE dsh_notification_outbox
       SET attempt_count=attempt_count+1,next_attempt_at=?,last_error=?,updated_at=?
       WHERE event_fingerprint=? AND status='pending'`,
    ).run(retryAt, errorCode.slice(0, 500), now, eventFingerprint);
    const row = this.state.db.query(
      "SELECT attempt_count FROM dsh_notification_outbox WHERE event_fingerprint=?",
    ).get(eventFingerprint) as { attempt_count: number } | null;
    return Number(row?.attempt_count ?? 0);
  }

  /** Retain ambiguous post-send intent for reconciliation without an automatic duplicate send. */
  quarantineNotification(eventFingerprint: string, errorCode: string, messageId?: number): void {
    this.state.db.query(
      `UPDATE dsh_notification_outbox
       SET attempt_count=attempt_count+1,next_attempt_at=?,last_error=?,
           telegram_message_id=COALESCE(?,telegram_message_id),updated_at=?
       WHERE event_fingerprint=? AND status='pending'`,
    ).run(Number.MAX_SAFE_INTEGER, errorCode, messageId ?? null, Date.now(), eventFingerprint);
  }

  completeNotification(eventFingerprint: string, messageId: number, now = Date.now()): boolean {
    const complete = this.state.db.transaction(() => {
      const row = this.state.db.query(
        `SELECT telegram_chat_id,session_id,event_kind
         FROM dsh_notification_outbox
         WHERE event_fingerprint=? AND status='pending'`,
      ).get(eventFingerprint) as {
        telegram_chat_id: string;
        session_id: string;
        event_kind: string;
      } | null;
      if (!row) return false;

      this.state.db.query(
        `INSERT INTO dsh_message_links(
          telegram_chat_id,telegram_message_id,session_id,event_kind,event_fingerprint,sent_at
        ) VALUES (?,?,?,?,?,?)`,
      ).run(
        row.telegram_chat_id,
        messageId,
        row.session_id,
        row.event_kind,
        eventFingerprint,
        now,
      );

      const result = this.state.db.query(
        `UPDATE dsh_notification_outbox
         SET status='sent',message_text='',telegram_message_id=?,last_error=NULL,updated_at=?
         WHERE event_fingerprint=? AND status='pending'`,
      ).run(messageId, now, eventFingerprint);
      if (result.changes !== 1) throw new Error("dsh notification completion lost its pending state");
      return true;
    });
    return complete();
  }

  linkMessage(link: DshMessageLink, now = Date.now()): boolean {
    const result = this.state.db.query(
      `INSERT OR IGNORE INTO dsh_message_links(
        telegram_chat_id,telegram_message_id,session_id,event_kind,event_fingerprint,sent_at
      ) VALUES (?,?,?,?,?,?)`,
    ).run(
      link.chatId,
      link.messageId,
      link.sessionId,
      link.eventKind,
      link.eventFingerprint,
      now,
    );
    return result.changes === 1;
  }

  /** Select the latest mapped Telegram message across both providers in this chat. */
  findLatestReplyMessageId(chatId: string): number | null {
    const row = this.state.db.query(
      `SELECT MAX(telegram_message_id) AS message_id FROM (
        SELECT telegram_message_id FROM desktop_message_links WHERE telegram_chat_id=?
        UNION ALL
        SELECT telegram_message_id FROM dsh_message_links WHERE telegram_chat_id=?
      )`,
    ).get(chatId, chatId) as { message_id: number | null };
    return row.message_id;
  }

  findMessageLink(chatId: string, messageId: number): DshMessageLink | null {
    const row = this.state.db.query(
      `SELECT telegram_chat_id,telegram_message_id,session_id,event_kind,event_fingerprint
       FROM dsh_message_links WHERE telegram_chat_id=? AND telegram_message_id=?`,
    ).get(chatId, messageId) as {
      telegram_chat_id: string;
      telegram_message_id: number;
      session_id: string;
      event_kind: string;
      event_fingerprint: string;
    } | null;
    if (!row) return null;
    return {
      chatId: row.telegram_chat_id,
      messageId: Number(row.telegram_message_id),
      sessionId: row.session_id,
      eventKind: row.event_kind,
      eventFingerprint: row.event_fingerprint,
    };
  }

  saveObserverState(state: DshObserverState, now = Date.now()): void {
    this.state.db.query(
      `INSERT INTO dsh_observer_state(
        session_id,cursor,contract_fingerprint,last_event_fingerprint,updated_at
      ) VALUES (?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
        cursor=excluded.cursor,
        contract_fingerprint=excluded.contract_fingerprint,
        last_event_fingerprint=excluded.last_event_fingerprint,
        updated_at=excluded.updated_at`,
    ).run(
      state.sessionId,
      state.cursor,
      state.contractFingerprint,
      state.lastEventFingerprint,
      now,
    );
  }

  getObserverState(sessionId: string): DshObserverState | null {
    const row = this.state.db.query(
      `SELECT session_id,cursor,contract_fingerprint,last_event_fingerprint
       FROM dsh_observer_state WHERE session_id=?`,
    ).get(sessionId) as {
      session_id: string;
      cursor: number;
      contract_fingerprint: string;
      last_event_fingerprint: string | null;
    } | null;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      cursor: Number(row.cursor),
      contractFingerprint: row.contract_fingerprint,
      lastEventFingerprint: row.last_event_fingerprint,
    };
  }

  /** Atomically enqueue observed outcomes and advance one session cursor after continuity checks. */
  commitObservation(
    expectedCursor: number | null,
    state: DshObserverState,
    notifications: DshNotificationInput[],
    consumeCreatedBaseline: boolean,
  ): boolean {
    const commit = this.state.db.transaction(() => {
      const current = this.getObserverState(state.sessionId);
      if ((current?.cursor ?? null) !== expectedCursor ||
        (current && current.contractFingerprint !== state.contractFingerprint) ||
        (current && state.cursor < current.cursor)) return false;
      const marker = this.getCreatedSession(state.sessionId);
      if (expectedCursor === null && !consumeCreatedBaseline && marker?.baselinePending) return false;
      if (consumeCreatedBaseline && marker?.baselinePending !== true) return false;
      const now = Date.now();
      const lastCreated = this.state.db.query(
        `SELECT MAX(created_at) AS value
         FROM dsh_notification_outbox
         WHERE telegram_chat_id=? AND session_id=?`,
      ).get(
        notifications[0]?.chatId ?? "",
        state.sessionId,
      ) as { value: number | null } | null;
      const createdBase = Math.max(now, Number(lastCreated?.value ?? -1) + 1);
      notifications.forEach((notification, index) => {
        this.enqueueNotification(notification, now, createdBase + index);
      });
      this.saveObserverState(state, now);
      if (consumeCreatedBaseline) this.consumeCreatedSessionBaseline(state.sessionId);
      return true;
    });
    return commit();
  }

  acknowledgeCreation(
    updateId: number,
    chatId: string,
    messageId: number,
    sessionId: string,
    eventFingerprint: string,
    now = Date.now(),
  ): boolean {
    const acknowledge = this.state.db.transaction(() => {
      const creation = this.getCreation(updateId);
      if (!creation || creation.sessionId !== sessionId) return false;
      const existingLink = this.findMessageLink(chatId, messageId);
      if (creation.status === "acknowledged") {
        return existingLink?.sessionId === sessionId;
      }
      if (creation.status !== "accepted") return false;
      if (existingLink && (existingLink.sessionId !== sessionId ||
        existingLink.eventFingerprint !== eventFingerprint)) return false;
      if (!existingLink) {
        const linked = this.linkMessage({
          chatId,
          messageId,
          sessionId,
          eventKind: "session_created",
          eventFingerprint,
        }, now);
        if (!linked) return false;
      }
      const result = this.state.db.query(
        `UPDATE dsh_creation_requests
         SET status='acknowledged',updated_at=?
         WHERE telegram_update_id=? AND status='accepted' AND session_id=?`,
      ).run(now, updateId, sessionId);
      return result.changes === 1;
    });
    return acknowledge();
  }

  registerCreatedSession(
    sessionId: string,
    creationUpdateId: number,
    now = Date.now(),
  ): boolean {
    const result = this.state.db.query(
      `INSERT OR IGNORE INTO dsh_created_sessions(
        session_id,creation_update_id,baseline_pending,created_at
      ) VALUES (?,?,1,?)`,
    ).run(sessionId, creationUpdateId, now);
    return result.changes === 1;
  }

  getCreatedSession(sessionId: string): DshCreatedSession | null {
    const row = this.state.db.query(
      `SELECT session_id,creation_update_id,baseline_pending
       FROM dsh_created_sessions WHERE session_id=?`,
    ).get(sessionId) as {
      session_id: string;
      creation_update_id: number;
      baseline_pending: number;
    } | null;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      creationUpdateId: Number(row.creation_update_id),
      baselinePending: row.baseline_pending === 1,
    };
  }

  consumeCreatedSessionBaseline(sessionId: string): boolean {
    const result = this.state.db.query(
      "UPDATE dsh_created_sessions SET baseline_pending=0 WHERE session_id=? AND baseline_pending=1",
    ).run(sessionId);
    return result.changes === 1;
  }

  createPendingNewSessionPrompt(input: {
    chatId: string;
    promptMessageId: number;
    projectId: string;
    expiresAt: number;
  }, now = Date.now()): void {
    this.state.db.query(
      `INSERT INTO dsh_pending_new_session_prompts(
        telegram_chat_id,prompt_message_id,project_id,created_at,expires_at,status,consumed_at
      ) VALUES (?,?,?,?,?,'pending',NULL)
      ON CONFLICT(telegram_chat_id,prompt_message_id) DO UPDATE SET
        project_id=excluded.project_id,
        created_at=excluded.created_at,
        expires_at=excluded.expires_at,
        status='pending',
        consumed_at=NULL`,
    ).run(
      input.chatId,
      input.promptMessageId,
      input.projectId,
      now,
      input.expiresAt,
    );
  }

  consumePendingNewSessionPrompt(
    chatId: string,
    promptMessageId: number,
    now = Date.now(),
  ): PendingDshNewSessionPrompt | null {
    const consume = this.state.db.transaction(() => {
      const row = this.state.db.query(
        `SELECT telegram_chat_id,prompt_message_id,project_id,expires_at
         FROM dsh_pending_new_session_prompts
         WHERE telegram_chat_id=? AND prompt_message_id=? AND status='pending'`,
      ).get(chatId, promptMessageId) as {
        telegram_chat_id: string;
        prompt_message_id: number;
        project_id: string;
        expires_at: number;
      } | null;
      if (!row) return null;
      if (Number(row.expires_at) <= now) {
        this.state.db.query(
          `UPDATE dsh_pending_new_session_prompts
           SET status='expired'
           WHERE telegram_chat_id=? AND prompt_message_id=? AND status='pending'`,
        ).run(chatId, promptMessageId);
        return null;
      }
      const result = this.state.db.query(
        `UPDATE dsh_pending_new_session_prompts
         SET status='consumed',consumed_at=?
         WHERE telegram_chat_id=? AND prompt_message_id=? AND status='pending'`,
      ).run(now, chatId, promptMessageId);
      if (result.changes !== 1) return null;
      return {
        chatId: row.telegram_chat_id,
        promptMessageId: Number(row.prompt_message_id),
        projectId: row.project_id,
        expiresAt: Number(row.expires_at),
      };
    });
    return consume();
  }

  getPendingNewSessionPromptStatus(
    chatId: string,
    promptMessageId: number,
  ): "pending" | "consumed" | "expired" | null {
    const row = this.state.db.query(
      `SELECT status FROM dsh_pending_new_session_prompts
       WHERE telegram_chat_id=? AND prompt_message_id=?`,
    ).get(chatId, promptMessageId) as {
      status: "pending" | "consumed" | "expired";
    } | null;
    return row?.status ?? null;
  }

  /** Bound transient callback/prompt state growth without deleting delivery/audit history. */
  cleanupTransientState(now = Date.now(), retentionMs = 24 * 60 * 60_000): {
    callbacksExpired: number;
    callbacksDeleted: number;
    promptsExpired: number;
    promptsDeleted: number;
  } {
    const expireCallbacks = this.state.db.query(
      `UPDATE dsh_callback_tokens
       SET status='expired'
       WHERE status='pending' AND expires_at<=?`,
    ).run(now);
    const expirePrompts = this.state.db.query(
      `UPDATE dsh_pending_new_session_prompts
       SET status='expired'
       WHERE status='pending' AND expires_at<=?`,
    ).run(now);
    const cutoff = now - retentionMs;
    const deleteCallbacks = this.state.db.query(
      `DELETE FROM dsh_callback_tokens
       WHERE status IN ('consumed','expired')
         AND COALESCE(consumed_at,expires_at)<=?`,
    ).run(cutoff);
    const deletePrompts = this.state.db.query(
      `DELETE FROM dsh_pending_new_session_prompts
       WHERE status IN ('consumed','expired')
         AND COALESCE(consumed_at,expires_at)<=?`,
    ).run(cutoff);
    return {
      callbacksExpired: Number(expireCallbacks.changes),
      callbacksDeleted: Number(deleteCallbacks.changes),
      promptsExpired: Number(expirePrompts.changes),
      promptsDeleted: Number(deletePrompts.changes),
    };
  }
}

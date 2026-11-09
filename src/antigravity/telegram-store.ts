import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export type AntigravitySessionOrigin = "sea_bridge" | "desktop";
export type AntigravityCreationStatus = "received" | "dispatching" | "accepted" | "acknowledged" | "failed" | "delivery_unknown";
export type AntigravityDeliveryStatus = "received" | "dispatching" | "delivered" | "failed" | "delivery_unknown";

export interface AntigravityModelPreference { modelId: string; reasoningEffort: string | null }
export interface AntigravityMessageLink {
  chatId: string; messageId: number; sessionId: string;
  sessionOrigin: AntigravitySessionOrigin; eventKind: string; eventFingerprint: string;
}
export interface PendingAntigravityNewSessionPrompt {
  chatId: string; promptMessageId: number; projectId: string; projectName: string; expiresAt: number;
}
export interface AntigravityCreationRequest {
  updateId: number; projectId: string; modelId: string | null; reasoningEffort: string | null; promptHash: string;
  status: AntigravityCreationStatus; sessionId: string | null; turnId: string | null; errorCode: string | null;
}
export interface AntigravityDeliveryRecord {
  updateId: number; replyToMessageId: number; sessionId: string;
  textHash: string; status: AntigravityDeliveryStatus; errorCode: string | null;
}
export interface PendingAntigravityNotification {
  eventFingerprint: string; chatId: string; sessionId: string; sessionOrigin: AntigravitySessionOrigin;
  eventKind: string; text: string; attemptCount: number; nextAttemptAt: number;
}
export interface AntigravityObserverCursor { cursor: number; lastEventFingerprint: string | null }

const LEGAL_CREATION_TRANSITIONS: Readonly<Record<AntigravityCreationStatus, readonly AntigravityCreationStatus[]>> = {
  received: ["dispatching", "failed"], dispatching: ["accepted", "failed", "delivery_unknown"],
  accepted: ["acknowledged"], acknowledged: [], failed: [], delivery_unknown: [],
};

function callbackHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function encodeEventKind(origin: AntigravitySessionOrigin, eventKind: string): string {
  return `${origin}:${eventKind}`;
}

function decodeEventKind(raw: string): { sessionOrigin: AntigravitySessionOrigin; eventKind: string } {
  if (raw.startsWith("desktop:")) return { sessionOrigin: "desktop", eventKind: raw.slice("desktop:".length) };
  if (raw.startsWith("sea_bridge:")) return { sessionOrigin: "sea_bridge", eventKind: raw.slice("sea_bridge:".length) };
  return { sessionOrigin: "sea_bridge", eventKind: raw };
}

/** Persistence store for Antigravity Telegram callbacks, preferences, prompts, links, and outbox. */
export class AntigravityTelegramStore {
  constructor(private readonly db: Database) {}

  private getState<T>(key: string): { value: T; expiresAt: number | null; updatedAt: number } | null {
    const row = this.db
      .query("SELECT value_json AS valueJson, expires_at AS expiresAt, updated_at AS updatedAt FROM antigravity_telegram_state WHERE key=?")
      .get(key) as { valueJson: string; expiresAt: number | null; updatedAt: number } | null;
    if (!row) return null;
    try { return { value: JSON.parse(row.valueJson) as T, expiresAt: row.expiresAt, updatedAt: row.updatedAt }; }
    catch { return null; }
  }

  private setState(key: string, value: unknown, expiresAt: number | null, now: number): void {
    this.db.query(
      "INSERT INTO antigravity_telegram_state(key, value_json, expires_at, updated_at) VALUES(?,?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, expires_at=excluded.expires_at, updated_at=excluded.updated_at"
    ).run(key, JSON.stringify(value), expiresAt, now);
  }

  /** Store a single-use callback token bound to a chat and expiration timestamp. */
  putCallback(input: { token: string; chatId: string; action: string; payload: Record<string, unknown>; expiresAt: number }, now = Date.now()): void {
    this.setState(`cb:${callbackHash(input.token)}`, { chatId: input.chatId, action: input.action, payload: input.payload, status: "pending" }, input.expiresAt, now);
  }

  /** Consume a callback token at most once if it matches the chat and is unexpired. */
  consumeCallback(token: string, chatId: string, now = Date.now()): { action: string; payload: Record<string, unknown> } | null {
    const key = `cb:${callbackHash(token)}`;
    return this.db.transaction(() => {
      const state = this.getState<{ chatId: string; action: string; payload: Record<string, unknown>; status: string }>(key);
      if (!state || state.value.status !== "pending" || state.value.chatId !== chatId) return null;
      if (state.expiresAt !== null && state.expiresAt <= now) {
        this.setState(key, { ...state.value, status: "expired" }, state.expiresAt, now);
        return null;
      }
      this.setState(key, { ...state.value, status: "consumed" }, state.expiresAt, now);
      return { action: state.value.action, payload: state.value.payload };
    })();
  }

  /** Mark a callback token as expired immediately. */
  expireCallback(token: string, now = Date.now()): void {
    const key = `cb:${callbackHash(token)}`;
    const state = this.getState<{ chatId: string; action: string; payload: Record<string, unknown>; status: string }>(key);
    if (state && state.value.status === "pending") {
      this.setState(key, { ...state.value, status: "expired" }, state.expiresAt, now);
    }
  }

  /** Read per-chat default model and reasoning effort preference. */
  getDefaultModel(chatId: string): AntigravityModelPreference | null {
    const state = this.getState<AntigravityModelPreference>(`pref:model:${chatId}`);
    if (!state || typeof state.value?.modelId !== "string" || !state.value.modelId) return null;
    return {
      modelId: state.value.modelId,
      reasoningEffort: typeof state.value.reasoningEffort === "string" ? state.value.reasoningEffort : null,
    };
  }

  /** Save or clear per-chat default model and reasoning effort preference. */
  setDefaultModel(chatId: string, pref: AntigravityModelPreference | null, now = Date.now()): void {
    const key = `pref:model:${chatId}`;
    if (!pref) {
      this.db.query("DELETE FROM antigravity_telegram_state WHERE key=?").run(key);
      return;
    }
    this.setState(key, pref, null, now);
  }

  /** Record a pending ForceReply prompt for `/agy_new`. */
  createPendingNewSessionPrompt(input: PendingAntigravityNewSessionPrompt, now = Date.now()): void {
    this.setState(`prompt:${input.chatId}:${input.promptMessageId}`, { ...input, status: "pending" }, input.expiresAt, now);
  }

  /** Atomically consume a pending ForceReply prompt if unexpired. */
  consumePendingNewSessionPrompt(chatId: string, promptMessageId: number, now = Date.now()): PendingAntigravityNewSessionPrompt | null {
    const key = `prompt:${chatId}:${promptMessageId}`;
    return this.db.transaction(() => {
      const state = this.getState<PendingAntigravityNewSessionPrompt & { status: string }>(key);
      if (!state || state.value.status !== "pending") return null;
      if (state.value.expiresAt <= now) {
        this.setState(key, { ...state.value, status: "expired" }, state.expiresAt, now);
        return null;
      }
      this.setState(key, { ...state.value, status: "consumed" }, state.expiresAt, now);
      const { status: _s, ...rest } = state.value;
      return rest;
    })();
  }

  /** Inspect the status of a `/agy_new` ForceReply prompt. */
  getPendingNewSessionPromptStatus(chatId: string, promptMessageId: number, now = Date.now()): "pending" | "consumed" | "expired" | null {
    const key = `prompt:${chatId}:${promptMessageId}`;
    const state = this.getState<PendingAntigravityNewSessionPrompt & { status: "pending" | "consumed" | "expired" }>(key);
    if (!state) return null;
    if (state.value.status === "pending" && state.value.expiresAt <= now) {
      this.setState(key, { ...state.value, status: "expired" }, state.expiresAt, now);
      return "expired";
    }
    return state.value.status;
  }

  /** Claim an idempotent Telegram session creation by updateId. */
  beginCreation(updateId: number, projectId: string, modelId: string | null, reasoningEffort: string | null, promptHash: string, now = Date.now()): "new" | "duplicate" {
    const key = `create:${updateId}`;
    return this.db.transaction(() => {
      if (this.getState(key)) return "duplicate";
      const rec: AntigravityCreationRequest = {
        updateId, projectId, modelId, reasoningEffort, promptHash,
        status: "received", sessionId: null, turnId: null, errorCode: null,
      };
      this.setState(key, rec, null, now);
      return "new";
    })();
  }

  /** Read a Telegram creation request by updateId. */
  getCreation(updateId: number): AntigravityCreationRequest | null {
    return this.getState<AntigravityCreationRequest>(`create:${updateId}`)?.value ?? null;
  }

  /** Transition a Telegram creation request through the legal state machine. */
  transitionCreation(
    updateId: number,
    expectedStatus: AntigravityCreationStatus,
    nextStatus: AntigravityCreationStatus,
    detail: { sessionId?: string | null; turnId?: string | null; errorCode?: string | null } = {},
    now = Date.now()
  ): boolean {
    if (!LEGAL_CREATION_TRANSITIONS[expectedStatus].includes(nextStatus)) {
      throw new Error(`illegal antigravity creation transition: ${expectedStatus} -> ${nextStatus}`);
    }
    const key = `create:${updateId}`;
    return this.db.transaction(() => {
      const state = this.getState<AntigravityCreationRequest>(key);
      if (!state || state.value.status !== expectedStatus) return false;
      this.setState(key, {
        ...state.value,
        status: nextStatus,
        sessionId: detail.sessionId !== undefined ? detail.sessionId : state.value.sessionId,
        turnId: detail.turnId !== undefined ? detail.turnId : state.value.turnId,
        errorCode: detail.errorCode !== undefined ? detail.errorCode : state.value.errorCode,
      }, null, now);
      return true;
    })();
  }

  /** Atomically link the creation acknowledgement message and mark creation acknowledged. */
  acknowledgeCreation(updateId: number, chatId: string, messageId: number, sessionId: string, eventFingerprint: string, now = Date.now()): boolean {
    const key = `create:${updateId}`;
    return this.db.transaction(() => {
      const state = this.getState<AntigravityCreationRequest>(key);
      if (!state || state.value.sessionId !== sessionId) return false;
      const existingLink = this.findMessageLink(chatId, messageId);
      if (state.value.status === "acknowledged") return existingLink?.sessionId === sessionId;
      if (state.value.status !== "accepted") return false;
      if (existingLink && (existingLink.sessionId !== sessionId || existingLink.eventFingerprint !== eventFingerprint)) return false;
      if (!existingLink) {
        const linked = this.linkMessage({ chatId, messageId, sessionId, sessionOrigin: "sea_bridge", eventKind: "session_created", eventFingerprint }, now);
        if (!linked) return false;
      }
      this.setState(key, { ...state.value, status: "acknowledged" }, null, now);
      return true;
    })();
  }

  /** Claim an idempotent Telegram reply delivery by updateId. */
  claimDelivery(updateId: number, replyToMessageId: number, sessionId: string, textHash: string, now = Date.now()): "new" | "duplicate" {
    const key = `delivery:${updateId}`;
    return this.db.transaction(() => {
      if (this.getState(key)) return "duplicate";
      this.setState(key, { updateId, replyToMessageId, sessionId, textHash, status: "received", errorCode: null }, null, now);
      return "new";
    })();
  }

  /** Read a Telegram reply delivery record by updateId. */
  getDelivery(updateId: number): AntigravityDeliveryRecord | null {
    return this.getState<AntigravityDeliveryRecord>(`delivery:${updateId}`)?.value ?? null;
  }

  /** Transition a reply delivery from `received` to `dispatching`. */
  markDeliveryDispatching(updateId: number, now = Date.now()): boolean {
    const key = `delivery:${updateId}`;
    return this.db.transaction(() => {
      const state = this.getState<AntigravityDeliveryRecord>(key);
      if (!state || state.value.status !== "received") return false;
      this.setState(key, { ...state.value, status: "dispatching" }, null, now);
      return true;
    })();
  }

  /** Record terminal reply delivery status. */
  finishDelivery(updateId: number, status: Exclude<AntigravityDeliveryStatus, "received" | "dispatching">, errorCode: string | null = null, now = Date.now()): boolean {
    const key = `delivery:${updateId}`;
    return this.db.transaction(() => {
      const state = this.getState<AntigravityDeliveryRecord>(key);
      if (!state || !["received", "dispatching"].includes(state.value.status)) return false;
      this.setState(key, { ...state.value, status, errorCode }, null, now);
      return true;
    })();
  }

  /** Quarantine interrupted `dispatching` creations and deliveries after a restart. */
  recoverInterruptedWrites(now = Date.now()): { creations: number; deliveries: number } {
    let creations = 0;
    let deliveries = 0;
    this.db.transaction(() => {
      const rows = this.db
        .query("SELECT key, value_json AS valueJson FROM antigravity_telegram_state WHERE key LIKE 'create:%' OR key LIKE 'delivery:%'")
        .all() as Array<{ key: string; valueJson: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.valueJson) as { status?: string; errorCode?: string | null };
          if (parsed.status !== "dispatching") continue;
          this.setState(row.key, { ...parsed, status: "delivery_unknown", errorCode: "process_restart_after_dispatch" }, null, now);
          if (row.key.startsWith("create:")) creations++;
          else deliveries++;
        } catch {
          continue;
        }
      }
    })();
    return { creations, deliveries };
  }

  /** Link a Telegram message ID to an Antigravity session (`sea_bridge` or `desktop`). */
  linkMessage(link: AntigravityMessageLink, now = Date.now()): boolean {
    const res = this.db
      .query(
        "INSERT OR IGNORE INTO antigravity_message_links(" +
          "telegram_chat_id, telegram_message_id, session_id, session_origin, event_kind, event_fingerprint, sent_at" +
          ") VALUES(?,?,?,?,?,?,?)"
      )
      .run(link.chatId, link.messageId, link.sessionId, link.sessionOrigin, link.eventKind, link.eventFingerprint, now);
    return res.changes === 1;
  }

  /** Look up an Antigravity message link by `(chatId, messageId)`. */
  findMessageLink(chatId: string, messageId: number): AntigravityMessageLink | null {
    const row = this.db
      .query(
        "SELECT telegram_chat_id AS chatId, telegram_message_id AS messageId, session_id AS sessionId, " +
          "session_origin AS sessionOrigin, event_kind AS eventKind, event_fingerprint AS eventFingerprint " +
          "FROM antigravity_message_links WHERE telegram_chat_id=? AND telegram_message_id=?"
      )
      .get(chatId, messageId) as AntigravityMessageLink | null;
    return row ? { ...row, messageId: Number(row.messageId) } : null;
  }

  /** Find the latest mapped Telegram message ID across Codex, dsh, and Antigravity in this chat. */
  findLatestReplyMessageId(chatId: string): number | null {
    const row = this.db
      .query(
        "SELECT MAX(telegram_message_id) AS messageId FROM (" +
          "SELECT telegram_message_id FROM desktop_message_links WHERE telegram_chat_id=? " +
          "UNION ALL SELECT telegram_message_id FROM dsh_message_links WHERE telegram_chat_id=? " +
          "UNION ALL SELECT telegram_message_id FROM antigravity_message_links WHERE telegram_chat_id=?)"
      )
      .get(chatId, chatId, chatId) as { messageId: number | null } | null;
    return row?.messageId != null ? Number(row.messageId) : null;
  }

  /** Read observer cursor state for a managed or desktop session. */
  getObserverCursor(origin: AntigravitySessionOrigin, sessionId: string): AntigravityObserverCursor | null {
    return this.getState<AntigravityObserverCursor>(`obs:${origin}:${sessionId}`)?.value ?? null;
  }

  /** Save observer cursor state for a managed or desktop session. */
  saveObserverCursor(origin: AntigravitySessionOrigin, sessionId: string, cursor: AntigravityObserverCursor, now = Date.now()): void {
    this.setState(`obs:${origin}:${sessionId}`, cursor, null, now);
  }

  /** Enqueue a deduplicated notification in `antigravity_outbox`. */
  enqueueNotification(input: Omit<PendingAntigravityNotification, "attemptCount" | "nextAttemptAt">, now = Date.now()): boolean {
    const res = this.db
      .query(
        "INSERT OR IGNORE INTO antigravity_outbox(" +
          "event_fingerprint, telegram_chat_id, session_id, event_kind, message_text, status, attempt_count, next_attempt_at, created_at, updated_at" +
          ") VALUES(?,?,?,?,?,'pending',0,?,?,?)"
      )
      .run(input.eventFingerprint, input.chatId, input.sessionId, encodeEventKind(input.sessionOrigin, input.eventKind), input.text, now, now, now);
    return res.changes === 1;
  }

  /** List due pending notifications in per-session creation order. */
  listPendingNotifications(now = Date.now()): PendingAntigravityNotification[] {
    const rows = this.db
      .query(
        "SELECT event_fingerprint AS eventFingerprint, telegram_chat_id AS chatId, session_id AS sessionId, " +
          "event_kind AS rawKind, message_text AS text, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt " +
          "FROM antigravity_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at ASC, rowid ASC"
      )
      .all(now) as Array<{ eventFingerprint: string; chatId: string; sessionId: string; rawKind: string; text: string; attemptCount: number; nextAttemptAt: number }>;
    return rows.map((r) => {
      const { sessionOrigin, eventKind } = decodeEventKind(r.rawKind);
      return {
        eventFingerprint: r.eventFingerprint, chatId: r.chatId, sessionId: r.sessionId,
        sessionOrigin, eventKind, text: r.text,
        attemptCount: Number(r.attemptCount), nextAttemptAt: Number(r.nextAttemptAt),
      };
    });
  }

  /** Atomically mark an outbox notification as sent and link its Telegram message ID. */
  completeNotification(eventFingerprint: string, messageId: number, sessionOrigin: AntigravitySessionOrigin, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const row = this.db
        .query("SELECT telegram_chat_id AS chatId, session_id AS sessionId, event_kind AS rawKind, status FROM antigravity_outbox WHERE event_fingerprint=?")
        .get(eventFingerprint) as { chatId: string; sessionId: string; rawKind: string; status: string } | null;
      if (!row || row.status !== "pending") return false;
      const { eventKind } = decodeEventKind(row.rawKind);
      if (!this.linkMessage({ chatId: row.chatId, messageId, sessionId: row.sessionId, sessionOrigin, eventKind, eventFingerprint }, now)) return false;
      const updated = this.db
        .query("UPDATE antigravity_outbox SET status='sent', telegram_message_id=?, updated_at=? WHERE event_fingerprint=? AND status='pending'")
        .run(messageId, now, eventFingerprint);
      return updated.changes === 1;
    })();
  }

  /** Schedule a retry for a rate-limited outbox notification. */
  markNotificationFailed(eventFingerprint: string, errorCode: string, nextAttemptAt: number, now = Date.now()): void {
    this.db
      .query("UPDATE antigravity_outbox SET attempt_count=attempt_count+1, last_error=?, next_attempt_at=?, updated_at=? WHERE event_fingerprint=? AND status='pending'")
      .run(errorCode, nextAttemptAt, now, eventFingerprint);
  }

  /** Quarantine an ambiguous outbox notification so it is never re-sent automatically. */
  quarantineNotification(eventFingerprint: string, errorCode: string, messageId?: number, now = Date.now()): void {
    this.db
      .query("UPDATE antigravity_outbox SET status='quarantined', last_error=?, telegram_message_id=COALESCE(?, telegram_message_id), updated_at=? WHERE event_fingerprint=? AND status='pending'")
      .run(errorCode, messageId ?? null, now, eventFingerprint);
  }

  /** Save or read the Telegram message binding for a shared pending approval. */
  setApprovalMessage(approvalId: string, binding: { chatId: string; messageId: number }, now = Date.now()): void {
    this.setState(`ap_msg:${approvalId}`, binding, null, now);
  }

  getApprovalMessage(approvalId: string): { chatId: string; messageId: number } | null {
    return this.getState<{ chatId: string; messageId: number }>(`ap_msg:${approvalId}`)?.value ?? null;
  }

  /** Expire and prune transient callbacks and ForceReply prompts. */
  cleanupTransientState(now = Date.now(), retentionMs = 24 * 60 * 60_000): void {
    const cutoff = now - retentionMs;
    this.db
      .query("DELETE FROM antigravity_telegram_state WHERE (key LIKE 'cb:%' OR key LIKE 'prompt:%') AND expires_at IS NOT NULL AND expires_at<=?")
      .run(cutoff);
  }
}

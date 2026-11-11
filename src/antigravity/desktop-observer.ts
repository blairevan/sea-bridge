import { createHash } from "node:crypto";
import { redact } from "../security/redact.ts";
import type { InlineButton } from "../telegram/client.ts";
import type { AntigravityApprovalBridge } from "./approval-bridge.ts";
import type { AntigravityDesktopReader } from "./desktop-reader.ts";
import { createAntigravityCallback, formatAntigravityTerminal } from "./menu-ui.ts";
import { enqueueDesktopQuestionNotification, finalizeQuestionNotification, prepareNotificationKeyboard } from "./question-telegram-ui.ts";
import type { AntigravityApprovalRecord, AntigravityStore } from "./store.ts";
import type { AntigravityTelegramStore } from "./telegram-store.ts";

const TELEGRAM_SEND_TIMEOUT_MS = 15_000;
const MAX_POLL_BACKOFF_MS = 5 * 60_000;

export interface AntigravityTelegramTransport {
  sendMessage(chatId: string | number, text: string, buttons?: InlineButton[][]): Promise<{ message_id: number }>;
  editMessageReplyMarkup(chatId: string | number, messageId: number, buttons?: InlineButton[][]): Promise<unknown>;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Observes SeaBridge-managed Antigravity executions and read-only Antigravity Desktop sessions,
 * delivers deduplicated terminal notifications via `antigravity_outbox`, and synchronizes shared Web+Telegram approvals.
 */
export class AntigravityDesktopObserver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private polling = false;
  private activePoll: Promise<void> | null = null;
  private wakePending = false;
  private lastSuccessfulPollAt: number | null = null;
  private lastErrorCode: string | null = null;
  private consecutiveFailures = 0;
  private nextPollAt: number | null = null;
  private unsubscribeApprovals: (() => void) | null = null;

  constructor(
    private readonly deps: {
      store: AntigravityStore;
      tgStore: AntigravityTelegramStore;
      approvalBridge: AntigravityApprovalBridge;
      desktopReader?: AntigravityDesktopReader | undefined;
      telegram: AntigravityTelegramTransport;
      chatId: string;
      pollIntervalMs?: number | undefined;
      replyEnabled?: boolean | undefined;
      externalSessionsEnabled?: boolean | undefined;
    }
  ) {
    this.unsubscribeApprovals = this.deps.approvalBridge.addListener((sessionId, approval) => {
      void this.handleApprovalChanged(sessionId, approval);
    });
  }

  /** Start background polling for managed and desktop session terminal events. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runScheduledPoll();
  }

  /** Stop background polling and drain any active poll cycle. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
    this.unsubscribeApprovals?.();
    this.unsubscribeApprovals = null;
    if (this.activePoll) {
      await this.activePoll.catch(() => undefined);
    }
  }

  /** Wake observer immediately when a managed session finishes a turn. */
  wake(): void {
    if (!this.started) return;
    if (this.polling) {
      this.wakePending = true;
    } else {
      this.scheduleNextPoll(0);
    }
  }

  /** Return observer health snapshot for `/agy_status`. */
  getStatus(): {
    running: boolean;
    lastSuccessfulPollAt: number | null;
    lastErrorCode: string | null;
    consecutiveFailures: number;
    nextPollAt: number | null;
  } {
    return {
      running: this.started,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastErrorCode: this.lastErrorCode,
      consecutiveFailures: this.consecutiveFailures,
      nextPollAt: this.nextPollAt,
    };
  }

  /** Run a single observation + outbox delivery pass. */
  async pollOnce(): Promise<void> {
    this.observeManagedSessions();
    this.observeDesktopSessions();
    await this.deliverPending();
  }

  private observeManagedSessions(): void {
    const sessions = this.deps.store.listSessions(200);
    for (const sess of sessions) {
      if (sess.sessionOrigin === "desktop" || !sess.lastExecutionId) continue;
      const exec = this.deps.store.getExecution(sess.lastExecutionId);
      if (!exec || !["completed", "cancelled", "incomplete", "failed"].includes(exec.status)) continue;

      const prev = this.deps.tgStore.getObserverCursor("sea_bridge", sess.sessionId);
      if (prev && exec.epoch <= prev.cursor) continue;

      const msgs = this.deps.store.listMessages(sess.sessionId, sess.snapshotGeneration);
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && m.kind === "message");
      const formatted = formatAntigravityTerminal(
        exec.status,
        sess.title,
        lastAssistant?.text ?? null,
        "sea_bridge"
      );

      let lastFp = prev?.lastEventFingerprint ?? null;
      for (let i = 0; i < formatted.parts.length; i++) {
        const isFinal = i === formatted.parts.length - 1;
        const fp = createHash("sha256")
          .update(
            JSON.stringify({
              origin: "sea_bridge",
              sessionId: sess.sessionId,
              executionId: exec.executionId,
              epoch: exec.epoch,
              status: exec.status,
              partIndex: i,
              partCount: formatted.parts.length,
            })
          )
          .digest("hex");
        lastFp = fp;
        this.deps.tgStore.enqueueNotification({
          eventFingerprint: fp,
          chatId: this.deps.chatId,
          sessionId: sess.sessionId,
          sessionOrigin: "sea_bridge",
          eventKind: isFinal ? formatted.eventKind : `${formatted.eventKind}_part`,
          text: formatted.parts[i]!,
        });
      }

      this.deps.tgStore.saveObserverCursor("sea_bridge", sess.sessionId, {
        cursor: exec.epoch,
        lastEventFingerprint: lastFp,
      });
    }
  }

  private observeDesktopSessions(): void {
    if (!this.deps.desktopReader) return;
    const desktopSessions = this.deps.desktopReader.listSessions(100);
    const desktopWritable = Boolean(this.deps.replyEnabled && this.deps.externalSessionsEnabled);
    for (const desk of desktopSessions) {
      if (this.deps.store.getSession(desk.id)?.sessionOrigin === "sea_bridge") continue;
      const history = this.deps.desktopReader.readHistory(desk.id, 400);
      if (!history) continue;

      const assistantMsgs = history.messages.filter((m) => m.role === "assistant" && !m.questions?.length);
      const currentCursor = assistantMsgs.length;
      const prev = this.deps.tgStore.getObserverCursor("desktop", desk.id);

      if (desk.state === "waiting_user_input") {
        enqueueDesktopQuestionNotification({ tgStore: this.deps.tgStore, chatId: this.deps.chatId, desk, messages: history.messages, writable: desktopWritable });
        this.deps.tgStore.saveObserverCursor("desktop", desk.id, { cursor: currentCursor, lastEventFingerprint: prev?.lastEventFingerprint ?? null });
        continue;
      }

      if (!prev) {
        // First time observing this existing desktop session: record baseline without backfilling old notifications
        this.deps.tgStore.saveObserverCursor("desktop", desk.id, {
          cursor: currentCursor,
          lastEventFingerprint: null,
        });
        continue;
      }

      if (desk.state !== "idle" || currentCursor <= prev.cursor) continue;

      let lastFp = prev.lastEventFingerprint;
      const newMsgs = assistantMsgs.slice(prev.cursor);
      for (const msg of newMsgs) {
        const formatted = formatAntigravityTerminal("completed", desk.title, msg.text, "desktop", desktopWritable);
        for (let i = 0; i < formatted.parts.length; i++) {
          const isFinal = i === formatted.parts.length - 1;
          const fp = createHash("sha256")
            .update(
              JSON.stringify({
                origin: "desktop",
                sessionId: desk.id,
                messageId: msg.id,
                partIndex: i,
                partCount: formatted.parts.length,
              })
            )
            .digest("hex");
          lastFp = fp;
          this.deps.tgStore.enqueueNotification({
            eventFingerprint: fp,
            chatId: this.deps.chatId,
            sessionId: desk.id,
            sessionOrigin: "desktop",
            eventKind: isFinal ? formatted.eventKind : `${formatted.eventKind}_part`,
            text: formatted.parts[i]!,
          });
        }
      }

      this.deps.tgStore.saveObserverCursor("desktop", desk.id, {
        cursor: currentCursor,
        lastEventFingerprint: lastFp,
      });
    }
  }

  private async deliverPending(): Promise<void> {
    const blockedSessions = new Set<string>();
    for (const notification of this.deps.tgStore.listPendingNotifications()) {
      if (blockedSessions.has(notification.sessionId)) continue;
      let callbackTokens: string[] = [];
      try {
        const canReply =
          notification.sessionOrigin === "sea_bridge"
            ? Boolean(this.deps.replyEnabled)
            : Boolean(this.deps.replyEnabled && this.deps.externalSessionsEnabled);
        const prepared = prepareNotificationKeyboard({ tgStore: this.deps.tgStore, notification, canReply });
        callbackTokens = prepared.callbackTokens;

        const msg = await this.sendTelegramBounded(notification.chatId, notification.text, prepared.buttons);
        if (!this.deps.tgStore.completeNotification(notification.eventFingerprint, msg.message_id, notification.sessionOrigin)) {
          for (const t of callbackTokens) this.deps.tgStore.expireCallback(t);
          this.deps.tgStore.quarantineNotification(notification.eventFingerprint, "mapping_unknown", msg.message_id);
          blockedSessions.add(notification.sessionId);
        } else {
          finalizeQuestionNotification(this.deps.tgStore, notification, msg.message_id);
        }
      } catch (err) {
        for (const t of callbackTokens) this.deps.tgStore.expireCallback(t);
        const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
        if (code === 429) {
          const delay = Math.min(5_000 * 2 ** Math.min(notification.attemptCount, 6), 300_000);
          this.deps.tgStore.markNotificationFailed(
            notification.eventFingerprint,
            "telegram_rate_limited",
            Date.now() + delay
          );
        } else {
          this.deps.tgStore.quarantineNotification(notification.eventFingerprint, "telegram_delivery_unknown");
        }
        blockedSessions.add(notification.sessionId);
      }
    }
  }

  /** Synchronize a pending or settled approval with Telegram inline buttons. */
  async handleApprovalChanged(sessionId: string, approval: AntigravityApprovalRecord): Promise<void> {
    if (!this.deps.chatId) return;
    if (approval.status === "pending") {
      const now = Date.now();
      const ttlMs = Math.max(5_000, approval.expiresAt - now);
      const optionButtons: InlineButton[] = approval.options.map((opt) => ({
        text: `${opt.kind.startsWith("allow") ? "✅ " : "❌ "}${opt.name}`.slice(0, 40),
        callback_data: createAntigravityCallback(
          this.deps.tgStore,
          this.deps.chatId,
          "approval.decide",
          {
            sessionId,
            approvalId: approval.id,
            optionId: opt.optionId,
          },
          now,
          ttlMs
        ),
      }));
      const text = [
        "🔐 Antigravity 请求工具权限审批",
        `会话: ${shortId(sessionId)}`,
        `工具: ${String(redact(approval.toolName))}`,
        `摘要: ${String(redact(approval.toolTitle)).slice(0, 600)}`,
        `有效期: ${Math.ceil(ttlMs / 1000)} 秒`,
      ].join("\n");

      try {
        const msg = await this.deps.telegram.sendMessage(this.deps.chatId, text, [optionButtons]);
        this.deps.tgStore.setApprovalMessage(approval.id, { chatId: this.deps.chatId, messageId: msg.message_id });
        const latest = this.deps.store.getApproval(approval.id);
        if (latest && latest.status !== "pending") {
          await this.deps.telegram.editMessageReplyMarkup(this.deps.chatId, msg.message_id, []).catch(() => undefined);
        }
      } catch {
        // Web approval remains usable even if Telegram send fails
      }
      return;
    }

    const binding = this.deps.tgStore.getApprovalMessage(approval.id);
    if (binding) {
      await this.deps.telegram.editMessageReplyMarkup(binding.chatId, binding.messageId, []).catch(() => undefined);
    }
  }

  private async sendTelegramBounded(
    chatId: string,
    text: string,
    buttons?: InlineButton[][]
  ): Promise<{ message_id: number }> {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("antigravity_telegram_send_timeout"));
      }, TELEGRAM_SEND_TIMEOUT_MS);

      void this.deps.telegram.sendMessage(chatId, text, buttons).then(
        (msg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(msg);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextPollAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextPollAt = null;
      void this.runScheduledPoll();
    }, delayMs);
  }

  private async runScheduledPoll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const pollInterval = this.deps.pollIntervalMs ?? 5_000;
    const active = this.pollOnce();
    this.activePoll = active;
    try {
      await active;
      this.lastSuccessfulPollAt = Date.now();
      this.lastErrorCode = null;
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      this.lastErrorCode = err instanceof Error ? err.message : "observer_poll_failed";
    } finally {
      if (this.activePoll === active) this.activePoll = null;
      this.polling = false;
      if (this.started) {
        const immediate = this.wakePending;
        this.wakePending = false;
        const backoff = Math.min(pollInterval * 2 ** Math.min(this.consecutiveFailures, 6), MAX_POLL_BACKOFF_MS);
        this.scheduleNextPoll(immediate ? 0 : this.consecutiveFailures > 0 ? backoff : pollInterval);
      }
    }
  }
}

import { createHash } from "node:crypto";
import type { DshBridgeStore } from "../state/dsh-bridge-store.ts";
import type { InlineButton } from "../telegram/client.ts";
import type { DshWebHostClient } from "./web-host-client.ts";
import { createDshCallback } from "./menu-ui.ts";
import { recoverDshHistory } from "./history-recovery.ts";
import { formatDshTerminal } from "./notification-formatter.ts";

const CONTRACT_FINGERPRINT = "dsh-web-0.1.7-rc.2-terminal-text-v2";
const LEGACY_CONTRACT_FINGERPRINT = "dsh-web-0.1.7-rc.2-metadata-v1";
const TELEGRAM_SEND_TIMEOUT_MS = 15_000;
const REPLY_CALLBACK_TTL_MS = 24 * 60 * 60_000;
const MAX_POLL_BACKOFF_MS = 5 * 60_000;

type ReadHost =
  Pick<DshWebHostClient, "listSessions" | "followSnapshot" | "pageHistory"> &
  Partial<Pick<DshWebHostClient, "health" | "getTurnSummary">>;
interface SendTelegram {
  sendMessage(chatId: string | number, text: string, buttons?: InlineButton[][]): Promise<{ message_id: number }>;
}

/** Terminal observer: reads metadata plus committed visible assistant text; it never submits Host writes. */
export class DshSessionObserver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private polling = false;
  private activeAbortController: AbortController | null = null;
  private activePoll: Promise<void> | null = null;
  private lastSuccessfulPollAt: number | null = null;
  private lastErrorCode: string | null = null;
  private consecutiveFailures = 0;
  private nextPollAt: number | null = null;

  constructor(
    private readonly host: ReadHost,
    private readonly store: DshBridgeStore,
    private readonly telegram: SendTelegram,
    private readonly chatId: string,
    private readonly pollIntervalMs = 10_000,
    private readonly replyEnabled = false,
    private readonly jitterSource: () => number = Math.random,
  ) {
    if (!chatId) throw new Error("dsh observer requires an authorized Telegram chat");
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error("dsh observer requires a positive poll interval");
    }
  }

  /** Start fail-soft polling with bounded exponential retry after Host failures. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runScheduledPoll();
  }

  /** Stop scheduling, cancel the active Host request, and wait for the current poll to unwind. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
    this.activeAbortController?.abort();
    const active = this.activePoll;
    if (active) await active.catch(() => undefined);
  }

  /** Observe each listed session and deliver due dsh notifications independently. */
  async pollOnce(signal?: AbortSignal): Promise<void> {
    this.throwIfCancelled(signal);
    if (this.host.health) await this.host.health(signal);
    const sessions = await this.host.listSessions(signal);
    let firstError: unknown;
    for (const session of sessions) {
      this.throwIfCancelled(signal);
      try { await this.observeSession(session.sessionId, session.title, signal); }
      catch (error) {
        if (signal?.aborted) throw error;
        firstError ??= error;
      }
    }
    this.throwIfCancelled(signal);
    await this.deliverPending(signal);
    if (firstError) throw firstError;
  }

  /** Recover a contiguous interval before committing event intents and cursor together. */
  private async observeSession(sessionId: string, title?: string, signal?: AbortSignal): Promise<void> {
    let previous = this.store.getObserverState(sessionId);
    if (previous?.contractFingerprint === LEGACY_CONTRACT_FINGERPRINT) {
      this.store.saveObserverState({ ...previous, contractFingerprint: CONTRACT_FINGERPRINT });
      previous = { ...previous, contractFingerprint: CONTRACT_FINGERPRINT };
    } else if (previous && previous.contractFingerprint !== CONTRACT_FINGERPRINT) {
      throw new Error("dsh_observer_contract_changed");
    }
    const snapshot = await this.host.followSnapshot(sessionId, signal);
    if (snapshot.truncated || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < -1) {
      throw new Error("dsh_observer_snapshot_unavailable");
    }
    const created = this.store.getCreatedSession(sessionId);
    if (!previous && !created?.baselinePending) {
      if (!this.store.commitObservation(null, {
        sessionId, cursor: snapshot.cursor, contractFingerprint: CONTRACT_FINGERPRINT,
        lastEventFingerprint: null,
      }, [], false)) throw new Error("dsh_observer_cursor_conflict");
      return;
    }
    const fromSeq = previous?.cursor ?? -1;
    const recovered = await recoverDshHistory(fromSeq, snapshot.cursor,
      (beforeSeq) => this.host.pageHistory(sessionId, snapshot.cursor, beforeSeq, signal));
    const notifications = [];
    for (const event of recovered.events) {
      if (event.type !== "turn/end") continue;
      if (!Number.isSafeInteger(event.turn)) throw new Error("dsh_observer_terminal_turn_missing");
      if (!this.host.getTurnSummary) throw new Error("dsh_observer_turn_summary_unavailable");
      const summary = await this.host.getTurnSummary(sessionId, event.turn!, event.seq, signal);
      const formatted = formatDshTerminal(
        event.reasonKind ?? "unknown",
        title,
        summary.assistantText,
      );
      for (let partIndex = 0; partIndex < formatted.parts.length; partIndex++) {
        const isFinalPart = partIndex === formatted.parts.length - 1;
        const eventFingerprint = createHash("sha256")
          .update(JSON.stringify({
            sessionId,
            seq: event.seq,
            type: event.type,
            reasonKind: event.reasonKind ?? "unknown",
            assistantSeq: summary.assistantSeq,
            partIndex,
            partCount: formatted.parts.length,
          })).digest("hex");
        notifications.push({
          eventFingerprint,
          chatId: this.chatId,
          sessionId,
          eventKind: isFinalPart ? formatted.eventKind : `${formatted.eventKind}_part`,
          text: formatted.parts[partIndex]!,
        });
      }
    }
    if (!this.store.commitObservation(previous?.cursor ?? null, {
      sessionId, cursor: snapshot.cursor, contractFingerprint: CONTRACT_FINGERPRINT,
      lastEventFingerprint: notifications.at(-1)?.eventFingerprint ?? previous?.lastEventFingerprint ?? null,
    }, notifications, created?.baselinePending === true)) throw new Error("dsh_observer_cursor_conflict");
  }

  /** Deliver durable terminal notification chunks in per-session order. */
  private async deliverPending(signal?: AbortSignal): Promise<void> {
    const blockedSessions = new Set<string>();
    for (const notification of this.store.listPendingNotifications()) {
      this.throwIfCancelled(signal);
      if (blockedSessions.has(notification.sessionId)) continue;
      let callbackToken: string | null = null;
      try {
        let buttons: InlineButton[][] | undefined;
        if (this.replyEnabled && !notification.eventKind.endsWith("_part")) {
          const callbackData = createDshCallback(
            this.store,
            notification.chatId,
            "reply",
            { sessionId: notification.sessionId },
            Date.now(),
            REPLY_CALLBACK_TTL_MS,
          );
          callbackToken = callbackData.slice("dsh:".length);
          buttons = [[{ text: "💬 回复", callback_data: callbackData }]];
        }
        const message = await this.sendTelegram(notification.chatId, notification.text, buttons, signal);
        try {
          if (!this.store.completeNotification(notification.eventFingerprint, message.message_id)) {
            throw new Error("dsh_outbox_completion_conflict");
          }
        } catch {
          if (callbackToken) this.store.expireCallback(callbackToken);
          this.store.quarantineNotification(notification.eventFingerprint, "mapping_unknown", message.message_id);
          blockedSessions.add(notification.sessionId);
        }
      } catch (error) {
        if (callbackToken) this.store.expireCallback(callbackToken);
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === 429) {
          const delay = Math.min(5_000 * 2 ** Math.min(notification.attemptCount, 6), 300_000);
          this.store.markNotificationFailed(notification.eventFingerprint, "telegram_rate_limited", Date.now() + delay);
        } else {
          this.store.quarantineNotification(notification.eventFingerprint, "telegram_delivery_unknown");
        }
        blockedSessions.add(notification.sessionId);
      }
    }
  }

  /** Bound Telegram admission; timeout/cancellation is ambiguous and must never auto-replay. */
  private async sendTelegram(
    chatId: string,
    text: string,
    buttons?: InlineButton[][],
    signal?: AbortSignal,
  ): Promise<{ message_id: number }> {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(new Error("dsh_telegram_send_cancelled")));
      const timer = setTimeout(() => {
        finish(() => reject(new Error("dsh_telegram_send_timeout")));
      }, TELEGRAM_SEND_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void this.telegram.sendMessage(chatId, text, buttons).then(
        (message) => finish(() => resolve(message)),
        (error) => finish(() => reject(error)),
      );
    });
  }

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

  private retryDelayMs(failureCount = this.consecutiveFailures): number {
    if (failureCount <= 0) return this.pollIntervalMs;
    const exponent = Math.min(failureCount - 1, 20);
    const base = Math.min(this.pollIntervalMs * 2 ** exponent, MAX_POLL_BACKOFF_MS);
    const sample = Math.max(0, Math.min(1, this.jitterSource()));
    return Math.max(250, Math.round(base * (0.8 + sample * 0.4)));
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

  /** Keep dsh errors from escaping an optional observer's scheduling loop. */
  private async runScheduledPoll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const controller = new AbortController();
    this.activeAbortController = controller;
    const active = this.pollOnce(controller.signal);
    this.activePoll = active;
    try {
      await active;
      this.lastSuccessfulPollAt = Date.now();
      this.lastErrorCode = null;
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      const candidate = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      this.lastErrorCode = typeof candidate === "string"
        ? candidate
        : error instanceof Error
          ? error.name
          : "unknown_error";
      /* Observation remains fail-soft; retry on the next tick. */
    } finally {
      if (this.activePoll === active) this.activePoll = null;
      if (this.activeAbortController === controller) this.activeAbortController = null;
      this.polling = false;
      if (this.started) {
        this.scheduleNextPoll(this.consecutiveFailures > 0
          ? this.retryDelayMs()
          : this.pollIntervalMs);
      }
    }
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("dsh_observer_cancelled");
  }
}

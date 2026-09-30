import { createHash } from "node:crypto";
import type { DshBridgeStore } from "../state/dsh-bridge-store.ts";
import type { DshWebHostClient } from "./web-host-client.ts";
import { recoverDshHistory } from "./history-recovery.ts";
import { formatDshCompletion } from "./notification-formatter.ts";

const CONTRACT_FINGERPRINT = "dsh-web-0.1.7-rc.2-metadata-v1";
const TELEGRAM_SEND_TIMEOUT_MS = 15_000;

type ReadHost = Pick<DshWebHostClient, "listSessions" | "followSnapshot" | "pageHistory">;
interface SendTelegram {
  sendMessage(chatId: string | number, text: string): Promise<{ message_id: number }>;
}

/** Read-only metadata observer with isolated dsh outbox; it never submits Host writes. */
export class DshSessionObserver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private activeAbortController: AbortController | null = null;
  private activePoll: Promise<void> | null = null;

  constructor(
    private readonly host: ReadHost,
    private readonly store: DshBridgeStore,
    private readonly telegram: SendTelegram,
    private readonly chatId: string,
    private readonly pollIntervalMs = 10_000,
  ) {
    if (!chatId) throw new Error("dsh observer requires an authorized Telegram chat");
  }

  /** Start a fail-soft periodic poll; the caller owns the connector lifecycle. */
  start(): void {
    if (this.timer) return;
    void this.runScheduledPoll();
    this.timer = setInterval(() => void this.runScheduledPoll(), this.pollIntervalMs);
  }

  /** Stop scheduling, cancel the active Host request, and wait for the current poll to unwind. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.activeAbortController?.abort();
    const active = this.activePoll;
    if (active) await active.catch(() => undefined);
  }

  /** Observe each listed session and deliver due dsh notifications independently. */
  async pollOnce(signal?: AbortSignal): Promise<void> {
    this.throwIfCancelled(signal);
    const sessions = await this.host.listSessions(signal);
    let firstError: unknown;
    for (const session of sessions) {
      this.throwIfCancelled(signal);
      try { await this.observeSession(session.sessionId, signal); }
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
  private async observeSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const previous = this.store.getObserverState(sessionId);
    if (previous && previous.contractFingerprint !== CONTRACT_FINGERPRINT) {
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
    if (recovered.events.some((event) => event.type === "turn/end" &&
      event.reasonKind !== "completed")) throw new Error("dsh_observer_unverified_terminal_outcome");
    const notifications = recovered.events.filter((event) => event.type === "turn/end" &&
      event.reasonKind === "completed").map((event) => {
      const eventFingerprint = createHash("sha256")
        .update(JSON.stringify({ sessionId, seq: event.seq, type: event.type })).digest("hex");
      return { eventFingerprint, chatId: this.chatId, sessionId, eventKind: "completed",
        text: formatDshCompletion() };
    });
    if (!this.store.commitObservation(previous?.cursor ?? null, {
      sessionId, cursor: snapshot.cursor, contractFingerprint: CONTRACT_FINGERPRINT,
      lastEventFingerprint: notifications.at(-1)?.eventFingerprint ?? previous?.lastEventFingerprint ?? null,
    }, notifications, created?.baselinePending === true)) throw new Error("dsh_observer_cursor_conflict");
  }

  /** Send read-only notifications without exposing an unavailable reply action. */
  private async deliverPending(signal?: AbortSignal): Promise<void> {
    for (const notification of this.store.listPendingNotifications()) {
      this.throwIfCancelled(signal);
      try {
        const message = await this.sendTelegram(notification.chatId, notification.text, signal);
        try {
          if (!this.store.completeNotification(notification.eventFingerprint, message.message_id)) {
            throw new Error("dsh_outbox_completion_conflict");
          }
        } catch {
          this.store.quarantineNotification(notification.eventFingerprint, "mapping_unknown", message.message_id);
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === 429) {
          const delay = Math.min(5_000 * 2 ** Math.min(notification.attemptCount, 6), 300_000);
          this.store.markNotificationFailed(notification.eventFingerprint, "telegram_rate_limited", Date.now() + delay);
        } else {
          this.store.quarantineNotification(notification.eventFingerprint, "telegram_delivery_unknown");
        }
      }
    }
  }

  /** Bound Telegram admission; timeout/cancellation is ambiguous and must never auto-replay. */
  private async sendTelegram(chatId: string, text: string, signal?: AbortSignal): Promise<{ message_id: number }> {
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
      void this.telegram.sendMessage(chatId, text).then(
        (message) => finish(() => resolve(message)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  /** Keep dsh errors from escaping an optional observer's scheduling loop. */
  private async runScheduledPoll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const controller = new AbortController();
    this.activeAbortController = controller;
    const active = this.pollOnce(controller.signal);
    this.activePoll = active;
    try { await active; } catch { /* Observation remains partial; retry on the next tick. */ }
    finally {
      if (this.activePoll === active) this.activePoll = null;
      if (this.activeAbortController === controller) this.activeAbortController = null;
      this.polling = false;
    }
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("dsh_observer_cancelled");
  }
}

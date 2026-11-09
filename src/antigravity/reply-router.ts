import { createHash } from "node:crypto";
import type { SourceResult } from "../web/sources/types.ts";
import type { AntigravityDesktopAppController } from "./desktop-app-controller.ts";
import type { AntigravityTelegramStore } from "./telegram-store.ts";

export type AntigravityReplyResult =
  | { status: "duplicate"; sessionId: string }
  | { status: "delivered"; sessionId: string }
  | { status: "desktop_app_open"; sessionId: string }
  | { status: "session_busy"; sessionId: string }
  | { status: "desktop_read_only"; sessionId: string }
  | { status: "failed"; sessionId: string; errorCode: string }
  | { status: "delivery_unknown"; sessionId: string; errorCode: string };

function deliveryHash(sessionId: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ sessionId, text })).digest("hex");
}

function requestId(updateId: number): string {
  return `tg-agy-reply-${updateId}`;
}

/** Routes Telegram replies to managed Antigravity sessions with `update_id` idempotency and desktop read-only protection. */
export class AntigravityReplyRouter {
  constructor(
    private readonly deps: {
      tgStore: AntigravityTelegramStore;
      externalSessionsEnabled?: boolean | undefined;
      desktopAppController?: AntigravityDesktopAppController | undefined;
      sessionManager: {
        send(id: string, operationId: string, prompt: string): Promise<SourceResult>;
      };
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Deliver a Telegram reply to the mapped Antigravity session. */
  async deliver(
    updateId: number,
    chatId: string,
    replyMessageId: number,
    text: string,
    options?: { bypassDesktopOpenCheck?: boolean }
  ): Promise<AntigravityReplyResult> {
    const link = this.deps.tgStore.findMessageLink(chatId, replyMessageId);
    if (!link) {
      return { status: "failed", sessionId: "", errorCode: "unmapped_reply" };
    }
    if (link.sessionOrigin === "desktop" && !this.deps.externalSessionsEnabled) {
      return { status: "desktop_read_only", sessionId: link.sessionId };
    }

    const normalized = text.trim();
    if (!normalized) {
      return { status: "failed", sessionId: link.sessionId, errorCode: "empty_prompt" };
    }

    if (
      !options?.bypassDesktopOpenCheck &&
      link.sessionOrigin === "desktop" &&
      this.deps.desktopAppController &&
      !this.deps.tgStore.getDelivery(updateId)
    ) {
      const openInApp = await this.deps.desktopAppController.isSessionOpenInDesktopApp(link.sessionId);
      if (openInApp) {
        await this.deps.desktopAppController.sendConfirmationPrompt({
          updateId,
          chatId,
          replyToMessageId: replyMessageId,
          sessionId: link.sessionId,
          text: normalized,
        });
        return { status: "desktop_app_open", sessionId: link.sessionId };
      }
    }

    const hash = deliveryHash(link.sessionId, normalized);
    const claim = this.deps.tgStore.claimDelivery(updateId, replyMessageId, link.sessionId, hash, this.now());
    const current = this.deps.tgStore.getDelivery(updateId);
    if (!current) {
      return { status: "delivery_unknown", sessionId: link.sessionId, errorCode: "delivery_state_missing" };
    }
    if (
      current.sessionId !== link.sessionId ||
      current.replyToMessageId !== replyMessageId ||
      current.textHash !== hash
    ) {
      return { status: "failed", sessionId: link.sessionId, errorCode: "duplicate_payload_mismatch" };
    }

    if (claim === "duplicate") {
      if (current.status === "delivered") return { status: "duplicate", sessionId: link.sessionId };
      if (current.status === "delivery_unknown") {
        return {
          status: "delivery_unknown",
          sessionId: link.sessionId,
          errorCode: current.errorCode ?? "delivery_unknown",
        };
      }
      if (current.status === "failed") {
        return current.errorCode === "session_busy"
          ? { status: "session_busy", sessionId: link.sessionId }
          : { status: "failed", sessionId: link.sessionId, errorCode: current.errorCode ?? "rejected" };
      }
      if (current.status === "dispatching") {
        return { status: "delivery_unknown", sessionId: link.sessionId, errorCode: "already_dispatching" };
      }
    }

    if (!this.deps.tgStore.markDeliveryDispatching(updateId, this.now())) {
      const row = this.deps.tgStore.getDelivery(updateId);
      if (row?.status === "delivered") return { status: "duplicate", sessionId: link.sessionId };
      return {
        status: "delivery_unknown",
        sessionId: link.sessionId,
        errorCode: row?.errorCode ?? "dispatch_state_changed",
      };
    }

    try {
      const result = await this.deps.sessionManager.send(link.sessionId, requestId(updateId), normalized);
      if (result.state === "queued" || result.state === "accepted") {
        this.deps.tgStore.finishDelivery(updateId, "delivered", null, this.now());
        return { status: "delivered", sessionId: link.sessionId };
      }
      if (result.state === "failed") {
        const code = result.errorCode ?? "rejected";
        this.deps.tgStore.finishDelivery(updateId, "failed", code, this.now());
        if (code === "session_busy") {
          return { status: "session_busy", sessionId: link.sessionId };
        }
        if (code === "desktop_session_read_only") {
          return { status: "desktop_read_only", sessionId: link.sessionId };
        }
        return { status: "failed", sessionId: link.sessionId, errorCode: code };
      }
      const code = result.errorCode ?? "delivery_unknown";
      this.deps.tgStore.finishDelivery(updateId, "delivery_unknown", code, this.now());
      return { status: "delivery_unknown", sessionId: link.sessionId, errorCode: code };
    } catch {
      this.deps.tgStore.finishDelivery(updateId, "delivery_unknown", "transport_lost_after_dispatch", this.now());
      return {
        status: "delivery_unknown",
        sessionId: link.sessionId,
        errorCode: "transport_lost_after_dispatch",
      };
    }
  }
}

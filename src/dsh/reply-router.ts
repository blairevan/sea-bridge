import { createHash } from "node:crypto";
import type { DshBridgeStore } from "../state/dsh-bridge-store.ts";
import type { DshWebHostClient } from "./web-host-client.ts";

type PromptHost = Pick<DshWebHostClient, "submitPrompt">;

export type DshReplyResult =
  | { status: "duplicate"; sessionId: string }
  | { status: "delivered"; sessionId: string }
  | { status: "busy_or_writer_held"; sessionId: string }
  | { status: "failed"; sessionId: string; errorCode: string }
  | { status: "delivery_unknown"; sessionId: string; errorCode: string };

function deliveryHash(sessionId: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ sessionId, text })).digest("hex");
}

function requestId(updateId: number): string {
  return `sea-bridge-tg-${updateId}`;
}

export class DshReplyRouter {
  constructor(
    private readonly host: PromptHost,
    private readonly store: DshBridgeStore,
  ) {}

  async deliver(
    updateId: number,
    chatId: string,
    replyMessageId: number,
    text: string,
  ): Promise<DshReplyResult> {
    const link = this.store.findMessageLink(chatId, replyMessageId);
    if (!link) {
      return { status: "failed", sessionId: "", errorCode: "unmapped_reply" };
    }
    const normalized = text.trim();
    if (!normalized) {
      return { status: "failed", sessionId: link.sessionId, errorCode: "empty_prompt" };
    }
    const hash = deliveryHash(link.sessionId, normalized);
    const claim = this.store.claimDelivery(updateId, replyMessageId, link.sessionId, hash);
    const current = this.store.getDelivery(updateId);
    if (!current) {
      return { status: "delivery_unknown", sessionId: link.sessionId, errorCode: "delivery_state_missing" };
    }
    if (current.sessionId !== link.sessionId || current.replyToMessageId !== replyMessageId ||
      current.textHash !== hash) {
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
        return current.errorCode === "session/agent-busy" || current.errorCode === "session/writer-held"
          ? { status: "busy_or_writer_held", sessionId: link.sessionId }
          : { status: "failed", sessionId: link.sessionId, errorCode: current.errorCode ?? "rejected" };
      }
      if (current.status === "dispatching") {
        return { status: "delivery_unknown", sessionId: link.sessionId, errorCode: "already_dispatching" };
      }
    }

    if (!this.store.markDeliveryDispatching(updateId)) {
      const row = this.store.getDelivery(updateId);
      if (row?.status === "delivered") return { status: "duplicate", sessionId: link.sessionId };
      return {
        status: "delivery_unknown",
        sessionId: link.sessionId,
        errorCode: row?.errorCode ?? "dispatch_state_changed",
      };
    }

    try {
      const result = await this.host.submitPrompt(link.sessionId, requestId(updateId), normalized);
      if (result.status === "accepted") {
        this.store.finishDelivery(updateId, "delivered");
        return { status: "delivered", sessionId: link.sessionId };
      }
      if (result.status === "busy_or_writer_held") {
        this.store.finishDelivery(updateId, "failed", result.errorCode);
        return { status: "busy_or_writer_held", sessionId: link.sessionId };
      }
      if (result.status === "rejected") {
        this.store.finishDelivery(updateId, "failed", result.errorCode);
        return { status: "failed", sessionId: link.sessionId, errorCode: result.errorCode };
      }
      this.store.finishDelivery(updateId, "delivery_unknown", result.errorCode);
      return { status: "delivery_unknown", sessionId: link.sessionId, errorCode: result.errorCode };
    } catch {
      this.store.finishDelivery(updateId, "delivery_unknown", "transport_lost_after_dispatch");
      return {
        status: "delivery_unknown",
        sessionId: link.sessionId,
        errorCode: "transport_lost_after_dispatch",
      };
    }
  }
}

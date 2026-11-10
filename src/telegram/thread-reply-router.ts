import { createHash } from "node:crypto";
import type { ProcessCodexQueueClient } from "../desktop/codex-queue-client.ts";
import type { DesktopMessageStore } from "../state/desktop-message-store.ts";
import type { TelegramMessage } from "./client.ts";

export type ThreadReplyRouteResult =
  | { status: "missing_reply" }
  | { status: "unmapped_reply" }
  | { status: "duplicate" }
  | { status: "delivered"; threadId: string }
  | { status: "failed"; threadId: string }
  | { status: "delivery_unknown"; threadId: string };

type QueueClient = Pick<ProcessCodexQueueClient, "queue">;

function textHash(threadId: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ threadId, text })).digest("hex");
}

/** Deliver a direct callback reply (such as a question option selection) to a Codex thread idempotently. */
export async function deliverDirectThreadReply(
  updateId: number,
  replyToMessageId: number,
  threadId: string,
  text: string,
  store: DesktopMessageStore,
  queueClient: QueueClient,
): Promise<Exclude<ThreadReplyRouteResult, { status: "missing_reply" } | { status: "unmapped_reply" }>> {
  const trimmed = text.trim();
  if (!trimmed) return { status: "failed", threadId };
  if (store.beginDelivery(updateId, replyToMessageId, threadId, textHash(threadId, trimmed)) === "duplicate") {
    return { status: "duplicate" };
  }
  if (!store.markDispatching(updateId)) return { status: "duplicate" };

  const result = await queueClient.queue(threadId, `[Telegram reply]\n${trimmed}`, { source: "telegram", updateId });
  store.finishDelivery(updateId, result.status, result.exitCode, result.errorCode ?? null);
  return result.status === "delivered"
    ? { status: "delivered", threadId }
    : result.status === "delivery_unknown"
      ? { status: "delivery_unknown", threadId }
      : { status: "failed", threadId };
}

export async function routeThreadReply(
  updateId: number,
  message: TelegramMessage,
  store: DesktopMessageStore,
  queueClient: QueueClient,
): Promise<ThreadReplyRouteResult> {
  const reply = message.reply_to_message;
  const link = reply
    ? store.findLink(String(reply.chat.id), reply.message_id)
    : store.findLatestLink(String(message.chat.id));

  if (!link) {
    return reply ? { status: "unmapped_reply" } : { status: "missing_reply" };
  }

  const text = message.text?.trim() ?? "";
  const targetMessageId = reply?.message_id ?? link.messageId;
  return deliverDirectThreadReply(updateId, targetMessageId, link.threadId, text, store, queueClient);
}

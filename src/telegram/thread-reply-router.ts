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

  const text = message.text?.trim();
  if (!text) return { status: "failed", threadId: link.threadId };
  const targetMessageId = reply?.message_id ?? link.messageId;
  if (store.beginDelivery(updateId, targetMessageId, link.threadId, textHash(link.threadId, text)) === "duplicate") {
    return { status: "duplicate" };
  }
  if (!store.markDispatching(updateId)) return { status: "duplicate" };

  const result = await queueClient.queue(link.threadId, `[Telegram reply]\n${text}`);
  store.finishDelivery(updateId, result.status, result.exitCode, result.errorCode ?? null);
  return result.status === "delivered"
    ? { status: "delivered", threadId: link.threadId }
    : result.status === "delivery_unknown"
      ? { status: "delivery_unknown", threadId: link.threadId }
      : { status: "failed", threadId: link.threadId };
}

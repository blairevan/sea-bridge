import type { ProcessCodexQueueClient } from "../desktop/codex-queue-client.ts";
import type { DesktopMessageStore } from "../state/desktop-message-store.ts";
import type { DshBridgeStore } from "../state/dsh-bridge-store.ts";
import type { DshReplyRouter, DshReplyResult } from "../dsh/reply-router.ts";
import type { TelegramMessage } from "./client.ts";
import { routeThreadReply, type ThreadReplyRouteResult } from "./thread-reply-router.ts";

type QueueClient = Pick<ProcessCodexQueueClient, "queue">;

export type ProviderReplyResult =
  | { provider: "codex"; result: ThreadReplyRouteResult }
  | { provider: "dsh"; result: DshReplyResult }
  | { status: "unmapped_reply" | "provider_conflict" };

export async function routeProviderReply(
  updateId: number,
  message: TelegramMessage,
  codexStore: DesktopMessageStore,
  dshStore: DshBridgeStore,
  codexQueue: QueueClient,
  dshRouter: DshReplyRouter,
): Promise<ProviderReplyResult> {
  const reply = message.reply_to_message;
  if (!reply) {
    return { provider: "codex", result: await routeThreadReply(updateId, message, codexStore, codexQueue) };
  }

  const chatId = String(reply.chat.id);
  const codexLink = codexStore.findLink(chatId, reply.message_id);
  const dshLink = dshStore.findMessageLink(chatId, reply.message_id);
  if (codexLink && dshLink) return { status: "provider_conflict" };
  if (!codexLink && !dshLink) return { status: "unmapped_reply" };
  if (dshLink) {
    return {
      provider: "dsh",
      result: await dshRouter.deliver(updateId, chatId, reply.message_id, message.text?.trim() ?? ""),
    };
  }
  return {
    provider: "codex",
    result: await routeThreadReply(updateId, message, codexStore, codexQueue),
  };
}

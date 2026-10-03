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
  | { status: "unmapped_reply" | "provider_conflict" | "dsh_read_only" };

/** Route explicit replies exactly, or direct text to the latest mapped chat notification. */
export async function routeProviderReply(
  updateId: number,
  message: TelegramMessage,
  codexStore: DesktopMessageStore,
  dshStore: Pick<DshBridgeStore, "findLatestReplyMessageId" | "findMessageLink">,
  codexQueue: QueueClient,
  dshRouter?: DshReplyRouter,
): Promise<ProviderReplyResult> {
  const reply = message.reply_to_message;
  const chatId = String(reply?.chat.id ?? message.chat.id);
  const targetMessageId = reply?.message_id ?? dshStore.findLatestReplyMessageId(chatId);
  if (targetMessageId === null) {
    return { provider: "codex", result: { status: "missing_reply" } };
  }

  const codexLink = codexStore.findLink(chatId, targetMessageId);
  const dshLink = dshStore.findMessageLink(chatId, targetMessageId);
  if (codexLink && dshLink) return { status: "provider_conflict" };
  if (!codexLink && !dshLink) return { status: "unmapped_reply" };
  if (dshLink) {
    if (!dshRouter) return { status: "dsh_read_only" };
    return {
      provider: "dsh",
      result: await dshRouter.deliver(updateId, chatId, targetMessageId, message.text?.trim() ?? ""),
    };
  }
  return {
    provider: "codex",
    result: await routeThreadReply(updateId, {
      ...message,
      reply_to_message: reply ?? { message_id: targetMessageId, chat: message.chat },
    }, codexStore, codexQueue),
  };
}

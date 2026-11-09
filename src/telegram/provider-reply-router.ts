import type { AntigravityReplyResult, AntigravityReplyRouter } from "../antigravity/reply-router.ts";
import type { AntigravityTelegramStore } from "../antigravity/telegram-store.ts";
import type { ProcessCodexQueueClient } from "../desktop/codex-queue-client.ts";
import type { DshReplyResult, DshReplyRouter } from "../dsh/reply-router.ts";
import type { DesktopMessageStore } from "../state/desktop-message-store.ts";
import type { DshBridgeStore } from "../state/dsh-bridge-store.ts";
import type { TelegramMessage } from "./client.ts";
import { routeThreadReply, type ThreadReplyRouteResult } from "./thread-reply-router.ts";

type QueueClient = Pick<ProcessCodexQueueClient, "queue">;

export type ProviderReplyResult =
  | { provider: "codex"; result: ThreadReplyRouteResult }
  | { provider: "dsh"; result: DshReplyResult }
  | { provider: "antigravity"; result: AntigravityReplyResult }
  | {
      status:
        | "unmapped_reply"
        | "provider_conflict"
        | "dsh_read_only"
        | "antigravity_read_only"
        | "antigravity_desktop_read_only";
    };

/** Route explicit replies exactly, or direct text to the latest mapped chat notification across Codex, dsh, and Antigravity. */
export async function routeProviderReply(
  updateId: number,
  message: TelegramMessage,
  codexStore: DesktopMessageStore,
  dshStore?: Pick<DshBridgeStore, "findLatestReplyMessageId" | "findMessageLink">,
  codexQueue?: QueueClient,
  dshRouter?: DshReplyRouter,
  agyStore?: Pick<AntigravityTelegramStore, "findLatestReplyMessageId" | "findMessageLink">,
  agyRouter?: AntigravityReplyRouter
): Promise<ProviderReplyResult> {
  const reply = message.reply_to_message;
  const chatId = String(reply?.chat.id ?? message.chat.id);
  const targetMessageId =
    reply?.message_id ??
    agyStore?.findLatestReplyMessageId(chatId) ??
    dshStore?.findLatestReplyMessageId(chatId) ??
    null;

  if (targetMessageId === null) {
    return { provider: "codex", result: { status: "missing_reply" } };
  }

  const codexLink = codexStore.findLink(chatId, targetMessageId);
  const dshLink = dshStore?.findMessageLink(chatId, targetMessageId) ?? null;
  const agyLink = agyStore?.findMessageLink(chatId, targetMessageId) ?? null;

  const matchedProviders = [Boolean(codexLink), Boolean(dshLink), Boolean(agyLink)].filter(Boolean).length;
  if (matchedProviders > 1) return { status: "provider_conflict" };
  if (matchedProviders === 0) return { status: "unmapped_reply" };

  if (dshLink) {
    if (!dshRouter) return { status: "dsh_read_only" };
    return {
      provider: "dsh",
      result: await dshRouter.deliver(updateId, chatId, targetMessageId, message.text?.trim() ?? ""),
    };
  }

  if (agyLink) {
    if (agyLink.sessionOrigin === "desktop") {
      return { status: "antigravity_desktop_read_only" };
    }
    if (!agyRouter) return { status: "antigravity_read_only" };
    const agyRes = await agyRouter.deliver(updateId, chatId, targetMessageId, message.text?.trim() ?? "");
    if (agyRes.status === "desktop_read_only") {
      return { status: "antigravity_desktop_read_only" };
    }
    return {
      provider: "antigravity",
      result: agyRes,
    };
  }

  return {
    provider: "codex",
    result: await routeThreadReply(
      updateId,
      {
        ...message,
        reply_to_message: reply ?? { message_id: targetMessageId, chat: message.chat },
      },
      codexStore,
      codexQueue!
    ),
  };
}

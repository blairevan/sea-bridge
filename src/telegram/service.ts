import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { StateDb } from "../state/db.ts";
import type { DesktopMessageStore } from "../state/desktop-message-store.ts";
import type { DesktopSameSessionAdapter } from "../desktop/same-session-adapter.ts";
import type { ApprovalCoordinator, ApprovalDecision } from "../desktop/approval-coordinator.ts";
import type { ProcessCodexQueueClient } from "../desktop/codex-queue-client.ts";
import type { CodexThreadReader } from "../desktop/codex-thread-store.ts";
import { isAuthorized } from "../security/auth.ts";
import { TelegramClient, type TelegramUpdate } from "./client.ts";
import { routeThreadReply } from "./thread-reply-router.ts";

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class TelegramService {
  private stopped = false;
  private abortController: AbortController | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateDb,
    private readonly client: TelegramClient,
    private readonly desktop: DesktopSameSessionAdapter,
    private readonly approvals: ApprovalCoordinator,
    private readonly messages: DesktopMessageStore,
    private readonly queueClient: ProcessCodexQueueClient,
    private readonly logger: Logger,
    private readonly threadStore?: CodexThreadReader,
  ) {}

  async run(): Promise<void> {
    this.stopped = false;
    let offset = this.nextOffset();
    let backoffMs = 1000;

    while (!this.stopped) {
      this.abortController = new AbortController();
      try {
        const updates = await this.client.getUpdates(offset, 25, this.abortController.signal);
        backoffMs = 1000;
        for (const update of updates) {
          await this.processUpdate(update);
          offset = Math.max(offset, update.update_id + 1);
        }
      } catch (error: any) {
        if (this.stopped || error?.name === "AbortError") break;
        const retryAfterMs = typeof error?.retryAfter === "number" ? error.retryAfter * 1000 : backoffMs;
        this.logger.warn("telegram_poll_failed", { error: String(error), retryAfterMs });
        await Bun.sleep(retryAfterMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
  }

  private nextOffset(): number {
    const row = this.state.db.query("SELECT MAX(update_id) AS id FROM telegram_updates WHERE status='processed'").get() as { id: number | null };
    return row.id == null ? 0 : Number(row.id) + 1;
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const existing = this.state.db.query("SELECT status FROM telegram_updates WHERE update_id=?").get(update.update_id) as { status: string } | null;
    if (existing?.status === "processed") return;
    if (!existing) {
      this.state.db.query("INSERT INTO telegram_updates(update_id,received_at,payload_hash,status) VALUES (?,?,?,'received')")
        .run(update.update_id, Date.now(), hashPayload(update));
    }

    try {
      if (update.callback_query) await this.handleCallback(update);
      else if (update.message) await this.handleMessage(update);
      this.state.db.query("UPDATE telegram_updates SET status='processed',processed_at=? WHERE update_id=?").run(Date.now(), update.update_id);
    } catch (error) {
      this.state.db.query("UPDATE telegram_updates SET status='failed',error_code=? WHERE update_id=?").run(String(error).slice(0, 300), update.update_id);
      throw error;
    }
  }

  private async handleCallback(update: TelegramUpdate): Promise<void> {
    const callback = update.callback_query!;
    const chatId = callback.message?.chat.id;
    if (chatId == null || !isAuthorized(
      { userId: String(callback.from.id), chatId: String(chatId) },
      this.config.allowedUserId,
      this.config.allowedChatId,
    )) {
      await this.client.answerCallbackQuery(callback.id, "Unauthorized").catch(() => undefined);
      this.logger.warn("telegram_unauthorized_callback", { userId: String(callback.from.id), chatId: String(chatId ?? "") });
      return;
    }

    const data = callback.data ?? "";
    const approvalMatch = /^ap:([A-Za-z0-9_-]+):([ad])$/.exec(data);
    if (approvalMatch) {
      await this.client.answerCallbackQuery(callback.id);
      const token = approvalMatch[1]!;
      const decision: ApprovalDecision = approvalMatch[2] === "a" ? "allow" : "deny";
      const result = await this.approvals.resolveCallback(token, decision);
      if (result !== "resolved") {
        this.logger.warn("approval_callback_not_resolved", { result, updateId: update.update_id });
      }
      return;
    }

    const replyMatch = /^(?:reply|rep):([A-Za-z0-9_-]+)$/.exec(data);
    if (replyMatch) {
      await this.client.answerCallbackQuery(callback.id);
      const threadId = replyMatch[1]!;
      const replyToMessageId = callback.message?.message_id;
      const promptMessage = await this.client.sendMessage(
        chatId,
        "💬 请回复此消息，内容将投递给该 Codex 会话：",
        undefined,
        true,
        replyToMessageId,
      );
      this.messages.link({
        chatId: String(chatId),
        messageId: promptMessage.message_id,
        threadId,
        turnId: null,
        eventKind: "reply_prompt",
        eventFingerprint: createHash("sha256")
          .update("reply_prompt:" + chatId + ":" + promptMessage.message_id + ":" + threadId)
          .digest("hex"),
      });
      this.logger.info("telegram_reply_prompt_sent", {
        threadId,
        messageId: promptMessage.message_id,
        replyToMessageId,
      });
      return;
    }

    await this.client.answerCallbackQuery(callback.id);
  }

  private async handleMessage(update: TelegramUpdate): Promise<void> {
    const message = update.message!;
    if (!message.from || !isAuthorized(
      { userId: String(message.from.id), chatId: String(message.chat.id) },
      this.config.allowedUserId,
      this.config.allowedChatId,
    )) {
      this.logger.warn("telegram_unauthorized_message", { userId: String(message.from?.id ?? ""), chatId: String(message.chat.id) });
      return;
    }

    const text = message.text?.trim();
    if (!text) return;
    if (text === "/status") {
      await this.sendStatus(message.chat.id);
      return;
    }
    if (text.startsWith("/")) {
      await this.client.sendMessage(message.chat.id, "Unsupported command in current milestone. Available: /status");
      return;
    }

    const result = await routeThreadReply(update.update_id, message, this.messages, this.queueClient);
    if (result.status === "missing_reply") {
      await this.client.sendMessage(message.chat.id, "请回复某条 Sea-Bridge 会话通知，以选择要继续的 Codex 会话。");
      return;
    }
    if (result.status === "unmapped_reply") {
      await this.client.sendMessage(message.chat.id, "这条消息不属于 Sea-Bridge 通知，无法确定 Codex 会话。");
      return;
    }
    if (result.status === "duplicate") return;
    if (result.status === "delivered") {
      const threadTitle = this.threadStore?.getThread?.(result.threadId)?.title || result.threadId;
      await this.client.sendMessage(message.chat.id, `已投递到对应的 Codex Desktop 会话：${threadTitle}`);
      this.logger.info("telegram_thread_reply_delivered", { threadId: result.threadId, updateId: update.update_id, threadTitle });
      return;
    }
    if (result.status === "delivery_unknown") {
      await this.client.sendMessage(message.chat.id, "投递状态不确定，请不要重复发送；可在 Codex Desktop 中确认是否已收到。");
      this.logger.warn("telegram_thread_reply_unknown", { threadId: result.threadId, updateId: update.update_id });
      return;
    }
    await this.client.sendMessage(message.chat.id, "投递失败，未发送到 Codex Desktop 会话。请稍后回复原通知重试。");
    this.logger.warn("telegram_thread_reply_failed", { threadId: result.threadId, updateId: update.update_id });
  }

  private async sendStatus(chatId: number): Promise<void> {
    const status = this.desktop.getObservedStatus();
    const latest = status.session;
    const lines = [
      "Sea-Bridge status",
      latest
        ? `Desktop session: ${latest.sessionId}\nTurn: ${latest.turnId ?? "-"}\nState: ${latest.activityState}\nLast event: ${latest.lastEvent}\nFreshness: ${Date.now() - latest.lastSeenAt}ms\nContinuation queue: ${status.continuationQueueLength}`
        : "Desktop session: not observed",
      "Capabilities:",
      ...status.capabilities.map((c) => `- ${c.name}: ${c.status}${c.provider ? ` (${c.provider})` : ""}${c.reason ? ` - ${c.reason}` : ""}`),
    ];
    await this.client.sendMessage(chatId, lines.join("\n"));
  }
}

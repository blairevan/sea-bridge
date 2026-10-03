import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { StateDb } from "../state/db.ts";
import type { DesktopMessageStore } from "../state/desktop-message-store.ts";
import type { DesktopSameSessionAdapter } from "../desktop/same-session-adapter.ts";
import type { ApprovalCoordinator, ApprovalDecision } from "../desktop/approval-coordinator.ts";
import type { ProcessCodexQueueClient } from "../desktop/codex-queue-client.ts";
import type { CodexThreadReader } from "../desktop/codex-thread-store.ts";
import type { NewThreadManager } from "../desktop/new-thread-manager.ts";
import type { ProjectItem, StartedThread } from "../desktop/codex-app-server-client.ts";
import type { DshReadOnlyBridge } from "../dsh/read-only-bridge.ts";
import type { DshBridgeStore } from "../state/dsh-bridge-store.ts";
import type { DshReplyRouter } from "../dsh/reply-router.ts";
import type { DshNewSessionManager } from "../dsh/new-session-manager.ts";
import { createDshCallback, renderDshModelMenu, renderDshProjectMenu } from "../dsh/menu-ui.ts";
import { isAuthorized } from "../security/auth.ts";
import { TelegramClient, type TelegramUpdate, type BotCommand } from "./client.ts";
import { renderModelMenu, renderProjectPage } from "./new-thread-ui.ts";
import { routeThreadReply } from "./thread-reply-router.ts";
import { routeProviderReply } from "./provider-reply-router.ts";

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface DshObserverStatusSource {
  getStatus(): {
    running: boolean;
    lastSuccessfulPollAt: number | null;
    lastErrorCode: string | null;
    consecutiveFailures: number;
    nextPollAt: number | null;
    liveSubscriptions?: number;
    liveReconnecting?: number;
  };
}

function splitTelegramLines(lines: string[], maxChars = 3500): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? current + "\n" + line : line;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export class TelegramService {
  private stopped = false;
  private abortController: AbortController | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollSuccessAt: number | null = null;
  private lastPollHealthLogAt = 0;
  private pollFailed = false;
  private activeUpdate: Promise<void> | null = null;

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
    private readonly newThreads?: NewThreadManager,
    private readonly dshReadOnly?: DshReadOnlyBridge,
    private readonly dshStore?: DshBridgeStore,
    private readonly dshReplyRouter?: DshReplyRouter,
    private readonly dshNewSessions?: DshNewSessionManager,
    private readonly dshObserverStatus?: DshObserverStatusSource,
  ) {}

  /** Project existing receive-poll health without probing Telegram or exposing payloads. */
  getStatus(): { stopped: boolean; lastPollSuccessAt: number | null; pollFailed: boolean } {
    return { stopped: this.stopped, lastPollSuccessAt: this.lastPollSuccessAt, pollFailed: this.pollFailed };
  }

  async run(): Promise<void> {
    this.stopped = false;
    if ((this.newThreads || this.dshStore) && !this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.newThreads?.cleanupExpired();
        } catch (error) {
          this.logger.warn("new_thread_cleanup_failed", { error: String(error) });
        }
        try {
          this.dshStore?.cleanupTransientState();
        } catch (error) {
          this.logger.warn("dsh_transient_cleanup_failed", { error: String(error) });
        }
      }, 60_000);
    }

    this.logger.info("telegram_polling_started");
    await this.syncBotCommands();
    if (this.stopped) return;

    let offset = this.nextOffset();
    let backoffMs = 1000;
    let processingBackoffMs = 1000;

    while (!this.stopped) {
      this.abortController = new AbortController();
      let updates: TelegramUpdate[];
      try {
        updates = await this.client.getUpdates(offset, 25, this.abortController.signal);
      } catch (error) {
        if (this.stopped || (error as { name?: string })?.name === "AbortError") break;
        const retryAfterMs = typeof (error as { retryAfter?: number })?.retryAfter === "number"
          ? (error as { retryAfter: number }).retryAfter * 1000
          : backoffMs;
        this.logger.warn("telegram_poll_failed", { error: String(error), retryAfterMs });
        this.pollFailed = true;
        await Bun.sleep(retryAfterMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
        continue;
      }

      const now = Date.now();
      if (this.pollFailed) {
        this.logger.info("telegram_polling_recovered", {
          outageMs: this.lastPollSuccessAt == null ? null : now - this.lastPollSuccessAt,
        });
        this.lastPollHealthLogAt = now;
      } else if (now - this.lastPollHealthLogAt >= 5 * 60_000) {
        this.logger.info("telegram_polling_healthy", {
          lastSuccessAt: new Date(now).toISOString(),
          updatesReceived: updates.length,
        });
        this.lastPollHealthLogAt = now;
      }
      this.lastPollSuccessAt = now;
      this.pollFailed = false;
      backoffMs = 1000;
      if (updates.length > 0) {
        this.logger.info("telegram_updates_received", {
          count: updates.length,
          firstUpdateId: updates[0]!.update_id,
          lastUpdateId: updates.at(-1)!.update_id,
        });
      }
      for (const update of updates) {
        if (this.stopped) break;
        const active = this.processUpdate(update); this.activeUpdate = active;
        try {
          await active;
          offset = Math.max(offset, update.update_id + 1);
          processingBackoffMs = 1000;
        } catch (error) {
          this.logger.error("telegram_update_processing_failed", {
            updateId: update.update_id,
            error: String(error),
          });
          if (!this.stopped) await Bun.sleep(processingBackoffMs);
          processingBackoffMs = Math.min(processingBackoffMs * 2, 30_000);
          break;
        } finally { if (this.activeUpdate === active) this.activeUpdate = null; }
      }
    }
  }

  /** Stop admission and drain an already dispatched update before its state database closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    await this.activeUpdate?.catch(() => undefined);
  }

  private async syncBotCommands(): Promise<void> {
    const commands: BotCommand[] = this.newThreads
      ? [
          { command: "new", description: "在项目下新建 Codex 会话" },
          { command: "projects", description: "查看可用项目列表" },
          { command: "model", description: "切换新建会话的默认模型" },
          { command: "status", description: "查看服务能力与会话状态" },
        ]
      : [{ command: "status", description: "查看服务能力与会话状态" }];
    if (this.dshReadOnly) {
      commands.push(
        { command: "dsh_status", description: "查看 dsh Web 连接与能力状态" },
        { command: "dsh_projects", description: "查看 dsh Web 项目目录" },
        { command: "dsh_model", description: this.dshNewSessions
          ? "选择 dsh 新会话默认模型"
          : "查看 dsh Web 模型目录" },
      );
      if (this.dshNewSessions) {
        commands.push({ command: "dsh_new", description: "在 dsh Web 项目下新建会话" });
      }
    }

    try {
      await this.client.setMyCommands?.(commands);
      this.logger.info("telegram_commands_synced", { commandCount: commands.length });
    } catch (error) {
      this.logger.warn("telegram_set_my_commands_failed", { error: String(error) });
    }
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

    const dshMatch = /^dsh:([A-Za-z0-9_-]+)$/.exec(data);
    if (dshMatch && this.dshStore) {
      const action = this.dshStore.consumeCallback(dshMatch[1]!, String(chatId));
      if (!action) {
        await this.client.answerCallbackQuery(callback.id, "操作已过期或已使用").catch(() => undefined);
        return;
      }
      await this.client.answerCallbackQuery(callback.id).catch(() => undefined);
      await this.handleDshCallbackAction(
        update.update_id,
        chatId,
        callback.message?.message_id,
        action.action,
        action.payload,
      );
      return;
    }

    if (this.newThreads) {
      if (data === "new:noop") {
        await this.client.answerCallbackQuery(callback.id);
        return;
      }

      if (data === "new:cancel") {
        await this.client.answerCallbackQuery(callback.id, "已取消");
        if (callback.message) {
          await this.client.editMessageReplyMarkup(chatId, callback.message.message_id, []).catch(() => undefined);
        }
        return;
      }

      const pageMatch = /^new:page:(\d+)$/.exec(data);
      if (pageMatch && callback.message) {
        await this.client.answerCallbackQuery(callback.id).catch(() => undefined);
        try {
          const projects = await this.newThreads.listProjects();
          const menu = renderProjectPage(projects, Number.parseInt(pageMatch[1]!, 10));
          await this.client.editMessageText(chatId, callback.message.message_id, menu.text, menu.buttons);
        } catch (error) {
          this.logger.warn("project_page_callback_failed", { error: String(error) });
          await this.client.sendMessage(chatId, "项目列表暂不可用，请稍后重新发送 /new。").catch(() => undefined);
        }
        return;
      }

      const projectMatch = /^new:proj:(.+)$/.exec(data);
      if (projectMatch) {
        await this.client.answerCallbackQuery(callback.id).catch(() => undefined);
        let project: ProjectItem | null;
        try {
          project = await this.newThreads.getProjectById(projectMatch[1]!, true);
        } catch (error) {
          this.logger.warn("project_select_callback_failed", { error: String(error) });
          await this.client.sendMessage(chatId, "项目列表暂不可用，请稍后重新发送 /new。").catch(() => undefined);
          return;
        }
        if (!project) {
          await this.client.sendMessage(chatId, "项目已变化，请重新发送 /new。").catch(() => undefined);
          return;
        }
        const promptMessage = await this.client.sendForceReply(
          chatId,
          `💬 已选择项目 [${project.name}]，请回复此消息输入第一轮需求。`,
          callback.message?.message_id,
          "输入第一轮需求",
        );
        this.newThreads.createPendingPrompt(String(chatId), promptMessage.message_id, project);
        this.logger.info("new_thread_prompt_requested", {
          projectId: project.id,
          promptMessageId: promptMessage.message_id,
          chatId: String(chatId),
        });
        return;
      }

      if (data === "model:close") {
        await this.client.answerCallbackQuery(callback.id);
        if (callback.message) {
          await this.client.editMessageReplyMarkup(chatId, callback.message.message_id, []).catch(() => undefined);
        }
        return;
      }

      if (data === "model:default") {
        this.newThreads.clearDefaultModel(String(chatId));
        await this.client.answerCallbackQuery(callback.id, "已切换为 Codex 默认模型").catch(() => undefined);
        if (callback.message) {
          try {
            const models = await this.newThreads.listModels();
            const menu = renderModelMenu(models, null);
            await this.client.editMessageText(chatId, callback.message.message_id, menu.text, menu.buttons);
          } catch (error) {
            this.logger.warn("model_default_menu_refresh_failed", { error: String(error) });
          }
        }
        return;
      }

      const modelMatch = /^model:set:(.+)$/.exec(data);
      if (modelMatch) {
        await this.client.answerCallbackQuery(callback.id).catch(() => undefined);
        let models;
        try {
          models = await this.newThreads.listModels(true);
        } catch (error) {
          this.logger.warn("model_select_callback_failed", { error: String(error) });
          await this.client.sendMessage(chatId, "模型列表暂不可用，请稍后重新执行 /model。").catch(() => undefined);
          return;
        }
        const model = models.find((item) => item.id === modelMatch[1]);
        if (!model) {
          await this.client.sendMessage(chatId, "模型列表已变化，请重新执行 /model。").catch(() => undefined);
          return;
        }
        this.newThreads.setDefaultModel(String(chatId), model.id);
        const menu = renderModelMenu(models, model.id);
        if (callback.message) {
          await this.client.editMessageText(chatId, callback.message.message_id, menu.text, menu.buttons).catch((error) => {
            this.logger.warn("model_menu_refresh_failed", { error: String(error) });
          });
        }
        return;
      }
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

    if (/^\/dsh_status(?:@\w+)?$/.test(text) && this.dshReadOnly) {
      await this.sendDshStatus(message.chat.id);
      return;
    }

    if (/^\/dsh_projects(?:@\w+)?$/.test(text) && this.dshReadOnly) {
      await this.sendDshProjects(message.chat.id);
      return;
    }

    if (/^\/dsh_model(?:@\w+)?$/.test(text) && this.dshReadOnly) {
      if (this.dshNewSessions && this.dshStore) {
        await this.sendDshModelMenu(message.chat.id, 0);
      } else {
        await this.sendDshModels(message.chat.id);
      }
      return;
    }

    const dshNewMatch = /^\/dsh_new(?:@\w+)?(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/.exec(text);
    if (dshNewMatch && this.dshNewSessions && this.dshStore) {
      const projectQuery = dshNewMatch[1];
      const prompt = dshNewMatch[2]?.trim();
      if (!projectQuery) {
        await this.sendDshProjectMenu(message.chat.id, 0);
        return;
      }
      let project;
      try {
        project = await this.dshNewSessions.findProject(projectQuery);
      } catch {
        await this.client.sendMessage(message.chat.id, "dsh Web 项目目录当前不可用，请稍后重试。");
        return;
      }
      if (!project) {
        await this.client.sendMessage(
          message.chat.id,
          "未找到唯一匹配的 dsh 项目，请发送 /dsh_projects 查看，或发送 /dsh_new 从菜单选择。",
        );
        return;
      }
      if (!prompt) {
        await this.requestDshPromptForProject(message.chat.id, project.id, project.title, message.message_id);
        return;
      }
      await this.createDshSessionAndAcknowledge(
        update.update_id,
        message.chat.id,
        project.id,
        prompt,
      );
      return;
    }

    if (/^\/projects(?:@\w+)?$/.test(text) && this.newThreads) {
      await this.sendProjects(message.chat.id);
      return;
    }

    if (/^\/model(?:@\w+)?$/.test(text) && this.newThreads) {
      await this.sendModelMenu(message.chat.id);
      return;
    }

    const newMatch = /^\/new(?:@\w+)?(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/.exec(text);
    if (newMatch && this.newThreads) {
      const projectQuery = newMatch[1];
      const prompt = newMatch[2]?.trim();
      if (!projectQuery) {
        await this.sendProjectMenu(message.chat.id, 0);
        return;
      }

      let project: ProjectItem | null;
      try {
        project = await this.newThreads.findProject(projectQuery, true);
      } catch (error) {
        this.logger.warn("new_thread_project_lookup_failed", { error: String(error) });
        await this.client.sendMessage(message.chat.id, "项目列表暂不可用，请稍后重试。");
        return;
      }
      if (!project) {
        await this.client.sendMessage(
          message.chat.id,
          "未找到唯一匹配的项目，请发送 /projects 查看序号，或发送 /new 从菜单选择。",
        );
        return;
      }

      if (!prompt) {
        await this.requestPromptForProject(message.chat.id, project, message.message_id);
        return;
      }

      await this.createThreadAndAcknowledge(
        update.update_id,
        message.chat.id,
        project.name,
        (onThreadStarted) => this.newThreads!.startThread(String(message.chat.id), project, prompt, onThreadStarted),
      );
      return;
    }

    if (text.startsWith("/")) {
      const available = [
        "/status",
        ...(this.newThreads ? ["/projects", "/model", "/new"] : []),
        ...(this.dshReadOnly
          ? ["/dsh_status", "/dsh_projects", "/dsh_model", ...(this.dshNewSessions ? ["/dsh_new"] : [])]
          : []),
      ].join(", ");
      await this.client.sendMessage(message.chat.id, `Unsupported command. Available: ${available}`);
      return;
    }

    if (this.dshNewSessions && message.reply_to_message) {
      const chatId = String(message.chat.id);
      const promptMessageId = message.reply_to_message.message_id;
      const dshStatus = this.dshNewSessions.getPendingPromptStatus(chatId, promptMessageId);
      const codexPending = this.newThreads?.getPendingPrompt(chatId, promptMessageId) ?? null;
      if (dshStatus === "pending" && codexPending) {
        this.logger.error("telegram_pending_provider_conflict", { chatId, promptMessageId });
        await this.client.sendMessage(
          message.chat.id,
          "这个输入请求同时存在 Codex 与 dsh 状态，已阻止执行，请重新发起新会话。",
        );
        return;
      }
      if (dshStatus === "pending") {
        const pending = this.dshNewSessions.consumePendingPrompt(chatId, promptMessageId);
        if (!pending) {
          await this.client.sendMessage(message.chat.id, "这个 dsh 新建会话请求已过期，请重新发送 /dsh_new。");
          return;
        }
        await this.createDshSessionAndAcknowledge(
          update.update_id,
          message.chat.id,
          pending.projectId,
          text,
        );
        return;
      }
      if (dshStatus === "expired") {
        await this.client.sendMessage(message.chat.id, "这个 dsh 新建会话请求已过期，请重新发送 /dsh_new。");
        return;
      }
      if (dshStatus === "consumed") {
        await this.client.sendMessage(message.chat.id, "这个 dsh 新建会话请求已经使用过，请重新发送 /dsh_new。");
        return;
      }
    }

    if (this.newThreads && message.reply_to_message) {
      const chatId = String(message.chat.id);
      const promptMessageId = message.reply_to_message.message_id;
      const pending = this.newThreads.getPendingPrompt(chatId, promptMessageId);
      if (pending) {
        const consumed = this.newThreads.consumePendingPrompt(chatId, promptMessageId);
        if (!consumed) {
          await this.client.sendMessage(message.chat.id, "这个新建会话请求已过期，请重新发送 /new。");
          return;
        }
        await this.createThreadAndAcknowledge(
          update.update_id,
          message.chat.id,
          consumed.projectName,
          (onThreadStarted) => this.newThreads!.startPendingThread(chatId, consumed, text, onThreadStarted),
        );
        return;
      }

      const promptStatus = this.newThreads.getPromptStatus(chatId, promptMessageId);
      if (promptStatus === "expired") {
        await this.client.sendMessage(message.chat.id, "这个新建会话请求已过期，请重新发送 /new。");
        return;
      }
      if (promptStatus === "consumed") {
        await this.client.sendMessage(message.chat.id, "这个新建会话请求已经使用过，请重新发送 /new 创建新的会话。");
        return;
      }
    }

    let result: Awaited<ReturnType<typeof routeThreadReply>>;
    if (this.dshStore && this.dshReplyRouter) {
      const routed = await routeProviderReply(
        update.update_id,
        message,
        this.messages,
        this.dshStore,
        this.queueClient,
        this.dshReplyRouter,
      );
      if ("status" in routed) {
        if (routed.status === "provider_conflict") {
          this.logger.error("telegram_provider_mapping_conflict", {
            updateId: update.update_id,
            chatId: String(message.chat.id),
            replyToMessageId: message.reply_to_message?.message_id,
          });
          await this.client.sendMessage(
            message.chat.id,
            "这条通知同时存在 Codex 与 dsh 映射，已阻止投递，请检查 Sea-Bridge 状态。",
          );
        } else {
          await this.client.sendMessage(message.chat.id, "这条消息不属于 Sea-Bridge 通知，无法确定会话。");
        }
        return;
      }
      if (routed.provider === "dsh") {
        const dshResult = routed.result;
        if (dshResult.status === "duplicate") return;
        if (dshResult.status === "delivered") {
          await this.client.sendMessage(message.chat.id, "已投递到对应的 dsh Web 会话。");
          return;
        }
        if (dshResult.status === "busy_or_writer_held") {
          await this.client.sendMessage(
            message.chat.id,
            "dsh Web 会话当前忙或被其他写者占用，本条内容未排队、未自动重试。",
          );
          return;
        }
        if (dshResult.status === "delivery_unknown") {
          await this.client.sendMessage(
            message.chat.id,
            "dsh Web 投递状态不确定，请不要重复发送；请先在 Web 会话中确认是否已收到。",
          );
          return;
        }
        await this.client.sendMessage(message.chat.id, "dsh Web 拒绝了本次投递，未自动重试。");
        return;
      }
      result = routed.result;
    } else {
      if (message.reply_to_message && this.dshReadOnly) {
        const chatId = String(message.chat.id);
        const replyToMessageId = message.reply_to_message.message_id;
        const dshLink = this.dshReadOnly.findMessageLink(chatId, replyToMessageId);
        const codexLink = this.messages.findLink(chatId, replyToMessageId);
        if (dshLink && codexLink) {
          this.logger.error("telegram_provider_mapping_conflict", {
            updateId: update.update_id,
            chatId,
            replyToMessageId,
          });
          await this.client.sendMessage(
            message.chat.id,
            "这条通知同时存在 Codex 与 dsh 映射，已阻止投递，请检查 Sea-Bridge 状态。",
          );
          return;
        }
        if (dshLink) {
          await this.client.sendMessage(
            message.chat.id,
            "这是 dsh Web 只读通知。当前回复功能尚未启用，本条内容没有发送到 dsh。",
          );
          return;
        }
      }
      result = await routeThreadReply(update.update_id, message, this.messages, this.queueClient);
    }
    if (result.status === "missing_reply") {
      await this.client.sendMessage(message.chat.id, "请先通过 /new 创建会话，或回复某条 Sea-Bridge 会话通知。");
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

  private async handleDshCallbackAction(
    updateId: number,
    chatId: number,
    sourceMessageId: number | undefined,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.dshStore) return;
    if (action === "reply") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (!sessionId || !this.dshReplyRouter) {
        await this.client.sendMessage(chatId, "dsh 回复功能当前不可用。");
        return;
      }
      const promptMessage = await this.client.sendForceReply(
        chatId,
        "💬 请回复此消息，内容将投递给该 dsh Web 会话：",
        sourceMessageId,
        "输入回复内容",
      );
      this.dshStore.linkMessage({
        chatId: String(chatId),
        messageId: promptMessage.message_id,
        sessionId,
        eventKind: "reply_prompt",
        eventFingerprint: createHash("sha256")
          .update(`dsh_reply_prompt:${chatId}:${promptMessage.message_id}:${sessionId}`)
          .digest("hex"),
      });
      return;
    }

    if (!this.dshNewSessions) {
      await this.client.sendMessage(chatId, "dsh 写功能当前不可用。");
      return;
    }

    if (action === "new.project.page") {
      const page = Number(payload.page);
      if (!Number.isSafeInteger(page) || page < 0 || sourceMessageId === undefined) return;
      const projects = await this.dshNewSessions.listProjects();
      const menu = renderDshProjectMenu(projects, page, String(chatId), this.dshStore);
      await this.client.editMessageText(chatId, sourceMessageId, menu.text, menu.buttons);
      return;
    }

    if (action === "new.project.select") {
      const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
      const project = projectId ? await this.dshNewSessions.getProjectById(projectId) : null;
      if (!project) {
        await this.client.sendMessage(chatId, "dsh 项目已变化，请重新发送 /dsh_new。");
        return;
      }
      await this.requestDshPromptForProject(chatId, project.id, project.title, sourceMessageId);
      return;
    }

    if (action === "model.page") {
      const page = Number(payload.page);
      if (!Number.isSafeInteger(page) || page < 0 || sourceMessageId === undefined) return;
      const { catalog, choices } = await this.dshNewSessions.listModelChoices();
      const current = this.dshNewSessions.getDefaultModel(String(chatId));
      const menu = renderDshModelMenu(
        choices,
        current,
        catalog.default,
        page,
        String(chatId),
        this.dshStore,
      );
      await this.client.editMessageText(chatId, sourceMessageId, menu.text, menu.buttons);
      return;
    }

    if (action === "model.default") {
      this.dshNewSessions.setDefaultModel(String(chatId), null);
      await this.client.sendMessage(chatId, "已切换为 dsh Host 默认模型。");
      return;
    }

    if (action === "model.select") {
      const provider = typeof payload.provider === "string" ? payload.provider : "";
      const model = typeof payload.model === "string" ? payload.model : "";
      const { choices } = await this.dshNewSessions.listModelChoices();
      const exists = choices.some((choice) => choice.provider === provider && choice.model === model);
      if (!exists) {
        await this.client.sendMessage(chatId, "模型目录已变化，请重新执行 /dsh_model。");
        return;
      }
      this.dshNewSessions.setDefaultModel(String(chatId), { provider, model });
      await this.client.sendMessage(chatId, `已选择 dsh 新会话模型：${provider} / ${model}`);
      return;
    }

    this.logger.warn("dsh_callback_unknown_action", { updateId, action });
    await this.client.sendMessage(chatId, "未知或已失效的 dsh 操作。");
  }

  private async sendDshProjectMenu(chatId: number, page: number): Promise<void> {
    if (!this.dshNewSessions || !this.dshStore) return;
    try {
      const projects = await this.dshNewSessions.listProjects();
      const menu = renderDshProjectMenu(projects, page, String(chatId), this.dshStore);
      await this.client.sendMessage(chatId, menu.text, menu.buttons);
    } catch {
      await this.client.sendMessage(chatId, "dsh Web 项目目录当前不可用，请稍后重试。");
    }
  }

  private async sendDshModelMenu(chatId: number, page: number): Promise<void> {
    if (!this.dshNewSessions || !this.dshStore) return;
    try {
      const { catalog, choices } = await this.dshNewSessions.listModelChoices();
      const current = this.dshNewSessions.getDefaultModel(String(chatId));
      const menu = renderDshModelMenu(
        choices,
        current,
        catalog.default,
        page,
        String(chatId),
        this.dshStore,
      );
      await this.client.sendMessage(chatId, menu.text, menu.buttons);
    } catch {
      await this.client.sendMessage(chatId, "dsh Web 模型目录当前不可用；现有模型偏好未改变。");
    }
  }

  private async requestDshPromptForProject(
    chatId: number,
    projectId: string,
    projectTitle: string,
    replyToMessageId?: number,
  ): Promise<void> {
    if (!this.dshNewSessions) return;
    const promptMessage = await this.client.sendForceReply(
      chatId,
      `💬 已选择 dsh 项目 [${projectTitle}]，请回复此消息输入第一轮需求。`,
      replyToMessageId,
      "输入第一轮需求",
    );
    this.dshNewSessions.createPendingPrompt(String(chatId), promptMessage.message_id, projectId);
  }

  private async createDshSessionAndAcknowledge(
    updateId: number,
    chatId: number,
    projectId: string,
    prompt: string,
  ): Promise<void> {
    if (!this.dshNewSessions || !this.dshStore) return;
    let outcome;
    try {
      outcome = await this.dshNewSessions.create(updateId, String(chatId), projectId, prompt);
    } catch (error) {
      this.logger.warn("dsh_new_session_failed", { updateId, error: String(error) });
      await this.client.sendMessage(chatId, "dsh 新会话启动失败，未自动重试。");
      return;
    }

    if (outcome.status === "failed") {
      const message = outcome.errorCode === "project_missing"
        ? "dsh 项目已变化，请重新发送 /dsh_new。"
        : outcome.errorCode === "model_unavailable"
          ? "已选择的 dsh 模型当前不可用，请重新执行 /dsh_model。"
          : "dsh 新会话创建被拒绝，未自动重试。";
      await this.client.sendMessage(chatId, message);
      return;
    }
    if (outcome.status === "delivery_unknown") {
      await this.client.sendMessage(
        chatId,
        "dsh 新会话或首轮需求的投递状态不确定，请不要重复创建；请先在 dsh Web 中确认。",
      );
      return;
    }
    if (outcome.status === "duplicate") return;

    const modelText = outcome.model
      ? `${outcome.model.provider} / ${outcome.model.model}`
      : "Host 默认";
    let acknowledgement;
    let acknowledgementCallbackToken: string | null = null;
    try {
      const callback = createDshCallback(
        this.dshStore,
        String(chatId),
        "reply",
        { sessionId: outcome.sessionId },
        Date.now(),
        24 * 60 * 60_000,
      );
      acknowledgementCallbackToken = callback.slice("dsh:".length);
      acknowledgement = await this.client.sendMessage(
        chatId,
        [
          "🚀 已创建 dsh Web 会话并接收第一轮需求",
          `项目: ${outcome.project.title}`,
          `会话: ${outcome.sessionId}`,
          `模型: ${modelText}`,
        ].join("\n"),
        [[{ text: "💬 回复", callback_data: callback }]],
      );
    } catch (error) {
      if (acknowledgementCallbackToken) this.dshStore.expireCallback(acknowledgementCallbackToken);
      this.logger.warn("dsh_new_session_ack_unknown", {
        updateId,
        sessionId: outcome.sessionId,
        error: String(error),
      });
      return;
    }
    if (!this.dshNewSessions.acknowledge(
      updateId,
      String(chatId),
      acknowledgement.message_id,
      outcome.sessionId,
    )) {
      if (acknowledgementCallbackToken) this.dshStore.expireCallback(acknowledgementCallbackToken);
      this.logger.error("dsh_new_session_ack_mapping_failed", {
        updateId,
        sessionId: outcome.sessionId,
        messageId: acknowledgement.message_id,
      });
    }
  }

  private async sendDshStatus(chatId: number): Promise<void> {
    try {
      const status = await this.dshReadOnly!.status();
      const byName = new Map(status.capabilities.map((capability) => [capability.name, capability]));
      const writeAvailable = Boolean(this.dshReplyRouter && this.dshNewSessions);
      const observer = this.dshObserverStatus?.getStatus();
      await this.client.sendMessage(chatId, [
        `dsh Web：已连接（${writeAvailable ? "完整模式" : "只读模式"}）`,
        `Connector: ${status.health.connectorVersion} / protocol ${status.health.protocol}`,
        `观察: ${byName.get("observation")?.status ?? "unknown"}`,
        ...(observer ? [
          `观察运行: ${observer.running ? "yes" : "no"}`,
          `实时监听: ${observer.liveSubscriptions ?? 0} 会话，重连中 ${observer.liveReconnecting ?? 0}`,
          `最近观察成功: ${observer.lastSuccessfulPollAt === null
            ? "-"
            : new Date(observer.lastSuccessfulPollAt).toISOString()}`,
          `观察错误: ${observer.lastErrorCode ?? "-"}`,
          `连续失败: ${observer.consecutiveFailures}`,
          `下次观察: ${observer.nextPollAt === null
            ? "-"
            : new Date(observer.nextPollAt).toISOString()}`,
        ] : []),
        `项目: ${byName.get("projects")?.status ?? "unknown"}`,
        `模型: ${byName.get("models")?.status ?? "unknown"}`,
        `回复: ${this.dshReplyRouter ? "available" : "unavailable"}`,
        `新建会话: ${this.dshNewSessions ? "available" : "unavailable"}`,
      ].join("\n"));
    } catch {
      await this.client.sendMessage(
        chatId,
        "dsh Web 连接当前不可用；Codex 功能不受影响。",
      );
    }
  }

  private async sendDshProjects(chatId: number): Promise<void> {
    try {
      const projects = await this.dshReadOnly!.listProjects();
      const lines = projects.length === 0
        ? ["dsh Web 当前没有可见项目。"]
        : [
            `📁 dsh Web 项目${this.dshNewSessions ? "：" : "（只读）："}`,
            ...projects.map((project, index) =>
              `[${index + 1}] ${project.title}（${project.sessionCount} 个会话）`),
            ...(this.dshNewSessions ? ["", "快捷创建：/dsh_new <序号> <需求>"] : []),
          ];
      for (const chunk of splitTelegramLines(lines)) {
        await this.client.sendMessage(chatId, chunk);
      }
    } catch {
      await this.client.sendMessage(chatId, "dsh Web 项目目录当前不可用；未执行任何写入。");
    }
  }

  private async sendDshModels(chatId: number): Promise<void> {
    try {
      const catalog = await this.dshReadOnly!.listModels();
      const lines = [
        "🤖 dsh Web 模型目录（只读，当前不支持切换）：",
        `当前默认: ${catalog.default.provider} / ${catalog.default.model}`,
        "",
        ...catalog.groups.flatMap((group) => [
          `[${group.name}]`,
          ...group.models.map((model) => `- ${model.name} (${model.id})`),
        ]),
      ];
      for (const chunk of splitTelegramLines(lines)) {
        await this.client.sendMessage(chatId, chunk);
      }
    } catch {
      await this.client.sendMessage(chatId, "dsh Web 模型目录当前不可用；现有模型状态未改变。");
    }
  }

  private async sendProjects(chatId: number): Promise<void> {
    try {
      const projects = await this.newThreads!.listProjects();
      if (projects.length === 0) {
        await this.client.sendMessage(chatId, "当前没有可用于新建会话的 Codex 项目。");
        return;
      }
      const lines = [
        "📁 Codex 项目：",
        ...projects.flatMap((project) => [
          `[${project.index}] ${project.name}`,
          `    ${project.primaryRoot}`,
        ]),
        "",
        "快捷创建：/new <序号> <需求>",
      ];
      for (const chunk of splitTelegramLines(lines)) {
        await this.client.sendMessage(chatId, chunk);
      }
    } catch (error) {
      this.logger.warn("project_list_failed", { error: String(error) });
      await this.client.sendMessage(chatId, "项目列表暂不可用，请稍后重试。");
    }
  }

  private async sendProjectMenu(chatId: number, page: number): Promise<void> {
    try {
      const projects = await this.newThreads!.listProjects();
      const menu = renderProjectPage(projects, page);
      await this.client.sendMessage(chatId, menu.text, menu.buttons);
    } catch (error) {
      this.logger.warn("project_menu_failed", { error: String(error) });
      await this.client.sendMessage(chatId, "项目列表暂不可用，请稍后重试。");
    }
  }

  private async sendModelMenu(chatId: number): Promise<void> {
    try {
      const models = await this.newThreads!.listModels();
      const selected = this.newThreads!.getDefaultModel(String(chatId));
      const menu = renderModelMenu(models, selected);
      await this.client.sendMessage(chatId, menu.text, menu.buttons);
    } catch (error) {
      this.logger.warn("model_list_failed", { error: String(error) });
      await this.client.sendMessage(chatId, "模型列表暂不可用；现有模型偏好未改变。");
    }
  }

  private async requestPromptForProject(chatId: number, project: ProjectItem, replyToMessageId?: number): Promise<void> {
    const promptMessage = await this.client.sendForceReply(
      chatId,
      `💬 已选择项目 [${project.name}]，请回复此消息输入第一轮需求。`,
      replyToMessageId,
      "输入第一轮需求",
    );
    this.newThreads!.createPendingPrompt(String(chatId), promptMessage.message_id, project);
  }

  /** Durably claim a creation update before dispatch; partial or uncertain results never replay. */
  private async createThreadAndAcknowledge(
    updateId: number,
    chatId: number,
    projectName: string,
    start: (onThreadStarted: (threadId: string) => void) => Promise<StartedThread>,
  ): Promise<void> {
    const claimed = this.state.db.query("INSERT OR IGNORE INTO codex_creation_requests(telegram_update_id,status,created_at,updated_at) VALUES(?,'dispatching',?,?)").run(updateId, Date.now(), Date.now());
    if (claimed.changes === 0) {
      const prior = this.state.db.query("SELECT status,thread_id AS threadId FROM codex_creation_requests WHERE telegram_update_id=?").get(updateId) as { status: string; threadId: string | null };
      await this.client.sendMessage(chatId, prior.status === "started"
        ? `此请求已创建会话 ${prior.threadId ?? ""}，不会重复执行。`
        : `此请求的派发结果待确认${prior.threadId ? `，已创建会话 ${prior.threadId}` : ""}，不会自动重复创建。`);
      return;
    }
    let started: StartedThread;
    try {
      started = await start((threadId) => {
        this.state.db.query("UPDATE codex_creation_requests SET thread_id=?,updated_at=? WHERE telegram_update_id=? AND status='dispatching'").run(threadId, Date.now(), updateId);
      });
      this.state.db.query("UPDATE codex_creation_requests SET status='started',thread_id=?,turn_id=?,updated_at=? WHERE telegram_update_id=?").run(started.threadId, started.turnId, Date.now(), updateId);
    } catch (error) {
      this.state.db.query("UPDATE codex_creation_requests SET status='delivery_unknown',updated_at=? WHERE telegram_update_id=? AND status='dispatching'").run(Date.now(), updateId);
      this.logger.warn("new_thread_start_failed", { projectName, error: String(error) });
      await this.client.sendMessage(
        chatId,
        "新会话启动未得到完整确认，请先检查会话及项目/模型状态；此请求不会自动重复创建。",
      );
      return;
    }

    let response;
    try {
      response = await this.client.sendMessage(
        chatId,
        [
          "🚀 已创建会话并开始执行",
          `项目: ${projectName}`,
          `会话: ${started.threadId}`,
          `模型: ${started.model ?? "Codex 默认"}`,
          "",
          "💡 提示：首轮任务正在 Sea-Bridge 后台执行。如果此时在 Codex Desktop 打开该会话，可能会提示“在另一个应用中打开”。待收到任务结束通知后，再在 Desktop 点击「重试」继续该会话。",
        ].join("\n"),
      );
    } catch (error) {
      // The turn is already running. Do not throw and let the same Telegram update
      // create a second thread on retry.
      this.logger.warn("new_thread_ack_failed", {
        projectName,
        threadId: started.threadId,
        turnId: started.turnId,
        error: String(error),
      });
      return;
    }

    try { this.messages.link({
      chatId: String(chatId),
      messageId: response.message_id,
      threadId: started.threadId,
      turnId: started.turnId,
      eventKind: "thread_created",
      eventFingerprint: createHash("sha256")
        .update(`thread_created:${chatId}:${response.message_id}:${started.threadId}:${started.turnId}`)
        .digest("hex"),
    }); } catch (error) {
      this.logger.warn("new_thread_mapping_failed", { threadId: started.threadId, turnId: started.turnId, error: String(error) });
    }
    this.logger.info("new_thread_started", {
      projectName,
      threadId: started.threadId,
      turnId: started.turnId,
      model: started.model,
    });
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

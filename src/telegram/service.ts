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
import { isAuthorized } from "../security/auth.ts";
import { TelegramClient, type TelegramUpdate } from "./client.ts";
import { renderModelMenu, renderProjectPage } from "./new-thread-ui.ts";
import { routeThreadReply } from "./thread-reply-router.ts";

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  ) {}

  async run(): Promise<void> {
    this.stopped = false;
    if (this.newThreads && !this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.newThreads?.cleanupExpired();
        } catch (error) {
          this.logger.warn("new_thread_cleanup_failed", { error: String(error) });
        }
      }, 60_000);
    }

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
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
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
        message.chat.id,
        project.name,
        () => this.newThreads!.startThread(String(message.chat.id), project, prompt),
      );
      return;
    }

    if (text.startsWith("/")) {
      const available = this.newThreads
        ? "/status, /projects, /model, /new"
        : "/status";
      await this.client.sendMessage(message.chat.id, `Unsupported command. Available: ${available}`);
      return;
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
          message.chat.id,
          consumed.projectName,
          () => this.newThreads!.startPendingThread(chatId, consumed, text),
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

    const result = await routeThreadReply(update.update_id, message, this.messages, this.queueClient);
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

  private async createThreadAndAcknowledge(
    chatId: number,
    projectName: string,
    start: () => Promise<StartedThread>,
  ): Promise<void> {
    let started: StartedThread;
    try {
      started = await start();
    } catch (error) {
      this.logger.warn("new_thread_start_failed", { projectName, error: String(error) });
      await this.client.sendMessage(
        chatId,
        "新会话启动失败，请检查项目/模型状态后重试；如刚切换过模型，可重新执行 /model。",
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

    this.messages.link({
      chatId: String(chatId),
      messageId: response.message_id,
      threadId: started.threadId,
      turnId: started.turnId,
      eventKind: "thread_created",
      eventFingerprint: createHash("sha256")
        .update(`thread_created:${chatId}:${response.message_id}:${started.threadId}:${started.turnId}`)
        .digest("hex"),
    });
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

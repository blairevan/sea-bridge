import { createHash } from "node:crypto";
import type { BotCommand, InlineButton } from "../telegram/client.ts";
import type { AntigravityApprovalBridge } from "./approval-bridge.ts";
import type { AntigravityCapabilityGate } from "./capabilities.ts";
import type { AntigravityConfig } from "./config.ts";
import type { AntigravityDesktopAppController } from "./desktop-app-controller.ts";
import type { AntigravityDesktopObserver } from "./desktop-observer.ts";
import { createAntigravityCallback, renderAntigravityModelMenu, renderAntigravityProjectMenu } from "./menu-ui.ts";
import type { AntigravityModelCatalog } from "./model-catalog.ts";
import type { AntigravityNewSessionManager } from "./new-session-manager.ts";
import type { AntigravityReplyRouter } from "./reply-router.ts";
import type { AntigravityStore } from "./store.ts";
import type { AntigravityTelegramStore } from "./telegram-store.ts";

export interface TelegramHandlerClient {
  sendMessage(chatId: string | number, text: string, buttons?: InlineButton[][], forceReply?: boolean, replyToMessageId?: number): Promise<{ message_id: number }>;
  sendForceReply(chatId: string | number, text: string, replyToMessageId?: number, placeholder?: string): Promise<{ message_id: number }>;
  editMessageText(chatId: string | number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<unknown>;
  editMessageReplyMarkup(chatId: string | number, messageId: number, buttons?: InlineButton[][]): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown>;
}

/** Encapsulates Antigravity Telegram commands (`/agy_*`), `agy:` callbacks, and ForceReply session creation. */
export class AntigravityTelegramHandler {
  constructor(
    private readonly deps: {
      config: AntigravityConfig; store: AntigravityStore; tgStore: AntigravityTelegramStore;
      capabilityGate: AntigravityCapabilityGate; modelCatalog: AntigravityModelCatalog;
      approvalBridge: AntigravityApprovalBridge; newSessions: AntigravityNewSessionManager;
      replyRouter: AntigravityReplyRouter; desktopAppController?: AntigravityDesktopAppController | undefined;
      observer?: AntigravityDesktopObserver | undefined; telegram: TelegramHandlerClient;
    }
  ) {}

  get tgStore(): AntigravityTelegramStore {
    return this.deps.tgStore;
  }

  get replyRouter(): AntigravityReplyRouter {
    return this.deps.replyRouter;
  }

  /** Return BotCommand descriptors when Antigravity is enabled. */
  getBotCommands(): BotCommand[] {
    if (!this.deps.config.enabled) return [];
    const commands: BotCommand[] = [
      { command: "agy_status", description: "查看 Antigravity ACP 连接与能力状态" },
      { command: "agy_projects", description: "查看 Antigravity 项目目录" },
      {
        command: "agy_model",
        description: this.deps.config.writeEnabled ? "选择 Antigravity 新会话模型与思考等级" : "查看 Antigravity 模型目录",
      },
    ];
    if (this.deps.config.writeEnabled) {
      commands.push({ command: "agy_new", description: "在 Antigravity 项目下新建会话" });
    }
    return commands;
  }

  /** Clean up expired callbacks and pending ForceReply prompts. */
  cleanupTransientState(): void {
    this.deps.tgStore.cleanupTransientState();
  }

  /** Inspect pending `/agy_new` ForceReply status for 3-way conflict detection. */
  getPendingPromptStatus(chatId: string, promptMessageId: number): "pending" | "consumed" | "expired" | null {
    if (!this.deps.config.enabled || !this.deps.config.writeEnabled) return null;
    return this.deps.newSessions.getPendingPromptStatus(chatId, promptMessageId);
  }

  /** Consume a pending `/agy_new` ForceReply prompt and create the managed session. */
  async handlePendingPromptReply(updateId: number, chatId: number, promptMessageId: number, text: string): Promise<void> {
    const status = this.getPendingPromptStatus(String(chatId), promptMessageId);
    if (status === "expired") {
      await this.deps.telegram.sendMessage(chatId, "这个 Antigravity 新建会话请求已过期，请重新发送 /agy_new。");
      return;
    }
    if (status === "consumed") {
      await this.deps.telegram.sendMessage(chatId, "这个 Antigravity 新建会话请求已经使用过，请重新发送 /agy_new。");
      return;
    }
    const pending = this.deps.newSessions.consumePendingPrompt(String(chatId), promptMessageId);
    if (!pending) {
      await this.deps.telegram.sendMessage(chatId, "这个 Antigravity 新建会话请求已过期，请重新发送 /agy_new。");
      return;
    }
    await this.createSessionAndAcknowledge(updateId, chatId, pending.projectId, text);
  }

  /** Handle `/agy_*` commands; returns `true` if matched and handled. */
  async tryHandleCommand(updateId: number, chatId: number, messageId: number, text: string): Promise<boolean> {
    if (!this.deps.config.enabled) return false;

    if (/^\/agy_status(?:@\w+)?$/.test(text)) {
      await this.sendStatus(chatId);
      return true;
    }
    if (/^\/agy_projects(?:@\w+)?$/.test(text)) {
      await this.sendProjects(chatId);
      return true;
    }
    if (/^\/agy_model(?:@\w+)?$/.test(text)) {
      if (this.deps.config.writeEnabled) {
        await this.sendModelMenu(chatId, 0);
      } else {
        await this.sendReadOnlyModels(chatId);
      }
      return true;
    }

    const newMatch = /^\/agy_new(?:@\w+)?(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/.exec(text);
    if (newMatch && this.deps.config.writeEnabled) {
      const projectQuery = newMatch[1];
      const prompt = newMatch[2]?.trim();
      if (!projectQuery) {
        await this.sendProjectMenu(chatId, 0);
        return true;
      }
      const project = await this.deps.newSessions.findProject(projectQuery);
      if (!project) {
        await this.deps.telegram.sendMessage(
          chatId,
          "未找到唯一匹配的 Antigravity 项目，请发送 /agy_projects 查看，或发送 /agy_new 从菜单选择。"
        );
        return true;
      }
      if (!prompt) {
        await this.requestPromptForProject(chatId, project.id, project.name, messageId);
        return true;
      }
      await this.createSessionAndAcknowledge(updateId, chatId, project.id, prompt);
      return true;
    }

    return false;
  }

  /** Handle `agy:<token>` callback queries; returns `true` if matched and handled. */
  async tryHandleCallback(_updateId: number, chatId: number, callbackId: string, sourceMessageId: number | undefined, data: string): Promise<boolean> {
    const match = /^agy:([A-Za-z0-9_-]+)$/.exec(data);
    if (!match) return false;
    if (!this.deps.config.enabled) {
      await this.deps.telegram.answerCallbackQuery(callbackId, "Antigravity 当前未启用").catch(() => undefined);
      return true;
    }

    const action = this.deps.tgStore.consumeCallback(match[1]!, String(chatId));
    if (!action) {
      await this.deps.telegram.answerCallbackQuery(callbackId, "操作已过期或已使用").catch(() => undefined);
      return true;
    }
    await this.deps.telegram.answerCallbackQuery(callbackId).catch(() => undefined);

    if (action.action === "reply") {
      const sessionId = typeof action.payload.sessionId === "string" ? action.payload.sessionId : "";
      if (!sessionId || !this.deps.config.writeEnabled) {
        await this.deps.telegram.sendMessage(chatId, "Antigravity 回复功能当前不可用。");
        return true;
      }
      const origin =
        this.deps.store.getSession(sessionId)?.sessionOrigin ??
        (sourceMessageId !== undefined ? this.deps.tgStore.findMessageLink(String(chatId), sourceMessageId)?.sessionOrigin : undefined) ??
        "sea_bridge";
      const promptMsg = await this.deps.telegram.sendForceReply(
        chatId,
        "💬 请回复此消息，内容将投递给该 Antigravity 会话：",
        sourceMessageId,
        "输入回复内容"
      );
      this.deps.tgStore.linkMessage({
        chatId: String(chatId),
        messageId: promptMsg.message_id,
        sessionId,
        sessionOrigin: origin,
        eventKind: "reply_prompt",
        eventFingerprint: createHash("sha256").update(`agy_reply_prompt:${chatId}:${promptMsg.message_id}:${sessionId}`).digest("hex"),
      });
      return true;
    }

    if (action.action === "desktop.reply.decide" && this.deps.desktopAppController) {
      await this.deps.desktopAppController.handleCallback(chatId, sourceMessageId, action.payload, this.deps.replyRouter);
      return true;
    }

    if (action.action === "approval.decide") {
      const sessionId = typeof action.payload.sessionId === "string" ? action.payload.sessionId : "";
      const approvalId = typeof action.payload.approvalId === "string" ? action.payload.approvalId : "";
      const optionId = typeof action.payload.optionId === "string" ? action.payload.optionId : "";
      if (!sessionId || !approvalId || !optionId) return true;

      const res = this.deps.approvalBridge.decide({ sessionId, approvalId, optionId, decidedBy: `telegram:${chatId}` });
      if (sourceMessageId !== undefined) {
        await this.deps.telegram.editMessageReplyMarkup(chatId, sourceMessageId, []).catch(() => undefined);
      }
      await this.deps.telegram.sendMessage(
        chatId,
        res.status === "decided" ? `已提交 Antigravity 工具权限决策：${optionId}` : "该权限请求已在其他终端处理或已过期。"
      );
      return true;
    }

    if (!this.deps.config.writeEnabled) {
      await this.deps.telegram.sendMessage(chatId, "Antigravity 写功能当前未启用。");
      return true;
    }

    if (action.action === "new.project.page") {
      const page = Number(action.payload.page);
      if (!Number.isSafeInteger(page) || page < 0 || sourceMessageId === undefined) return true;
      const menu = renderAntigravityProjectMenu(this.deps.newSessions.listProjects(), page, String(chatId), this.deps.tgStore);
      await this.deps.telegram.editMessageText(chatId, sourceMessageId, menu.text, menu.buttons);
      return true;
    }

    if (action.action === "new.project.select") {
      const projectId = typeof action.payload.projectId === "string" ? action.payload.projectId : "";
      const project = projectId ? this.deps.newSessions.getProjectById(projectId) : null;
      if (!project) {
        await this.deps.telegram.sendMessage(chatId, "Antigravity 项目已变化，请重新发送 /agy_new。");
        return true;
      }
      await this.requestPromptForProject(chatId, project.id, project.name, sourceMessageId);
      return true;
    }

    if (action.action === "model.page") {
      const page = Number(action.payload.page);
      if (!Number.isSafeInteger(page) || page < 0 || sourceMessageId === undefined) return true;
      const models = await this.deps.newSessions.listModels();
      const current = this.deps.newSessions.getDefaultModel(String(chatId));
      const menu = renderAntigravityModelMenu(models, current, page, String(chatId), this.deps.tgStore);
      await this.deps.telegram.editMessageText(chatId, sourceMessageId, menu.text, menu.buttons);
      return true;
    }

    if (action.action === "model.default") {
      this.deps.newSessions.setDefaultModel(String(chatId), null);
      if (sourceMessageId !== undefined) {
        const models = await this.deps.newSessions.listModels();
        const menu = renderAntigravityModelMenu(models, null, 0, String(chatId), this.deps.tgStore);
        await this.deps.telegram.editMessageText(chatId, sourceMessageId, menu.text, menu.buttons).catch(() => undefined);
      } else {
        await this.deps.telegram.sendMessage(chatId, "已切换为跟随 Antigravity 默认模型。");
      }
      return true;
    }

    if (action.action === "model.select" || action.action === "model.effort") {
      const modelId = typeof action.payload.modelId === "string" ? action.payload.modelId : "";
      const reasoningEffort = typeof action.payload.reasoningEffort === "string" ? action.payload.reasoningEffort : null;
      const resolved = await this.deps.modelCatalog.resolveSelection(modelId, reasoningEffort);
      if (!resolved) {
        await this.deps.telegram.sendMessage(chatId, "模型或思考等级已变化，请重新执行 /agy_model。");
        return true;
      }
      const nextPref = { modelId: resolved.baseModelId, reasoningEffort: resolved.reasoningEffort };
      this.deps.newSessions.setDefaultModel(String(chatId), nextPref);
      if (sourceMessageId !== undefined) {
        const models = await this.deps.newSessions.listModels();
        const menu = renderAntigravityModelMenu(models, nextPref, 0, String(chatId), this.deps.tgStore);
        await this.deps.telegram.editMessageText(chatId, sourceMessageId, menu.text, menu.buttons).catch(() => undefined);
      }
      return true;
    }

    return true;
  }

  private async sendStatus(chatId: number): Promise<void> {
    const statusState = this.deps.capabilityGate.toStatusState();
    const sessions = this.deps.store.listSessions(200);
    const runningCount = sessions.filter((s) => s.status === "running" || s.status === "cancelling").length;
    const obs = this.deps.observer?.getStatus();
    await this.deps.telegram.sendMessage(
      chatId,
      [
        `Antigravity ACP：已启用（${this.deps.config.writeEnabled ? "完整托管模式" : "只读模式"}）`,
        `状态: ${statusState}`,
        `托管会话: 共 ${sessions.length} 个（运行中 ${runningCount} 个）`,
        `桌面端只读展示: ${this.deps.config.desktopReadEnabled ? "已开启" : "已关闭"}`,
        `桌面端原会话写入互通: ${this.deps.config.externalSessionsEnabled ? "已开启" : "已关闭"}`,
        `工具权限策略: ${this.deps.config.approvalPolicy === "auto" ? "自动批准 (Turbo)" : "逐次询问 (Ask)"}`,
        ...(obs
          ? [
              `通知观察器: ${obs.running ? "运行中" : "已停止"}`,
              `最近观察成功: ${obs.lastSuccessfulPollAt ? new Date(obs.lastSuccessfulPollAt).toISOString() : "-"}`,
              `观察错误: ${obs.lastErrorCode ?? "-"}`,
            ]
          : []),
      ].join("\n")
    );
  }

  private async sendProjects(chatId: number): Promise<void> {
    const projects = this.deps.newSessions.listProjects();
    if (projects.length === 0) {
      await this.deps.telegram.sendMessage(chatId, "Antigravity 当前没有配置可用项目。");
      return;
    }
    const lines = [
      `📁 Antigravity 项目${this.deps.config.writeEnabled ? "：" : "（只读）："}`,
      ...projects.map((p, idx) => `[${idx + 1}] ${p.name}\n    ${p.rootPath}`),
      ...(this.deps.config.writeEnabled ? ["", "快捷创建：/agy_new <序号> <需求>"] : []),
    ];
    await this.deps.telegram.sendMessage(chatId, lines.join("\n"));
  }

  private async sendReadOnlyModels(chatId: number): Promise<void> {
    const models = await this.deps.newSessions.listModels();
    const lines = [
      "🤖 Antigravity 模型目录（只读）：",
      ...models.map((m) =>
        m.supportedReasoningEfforts?.length
          ? `- ${m.name} (${m.id}) · 思考等级: ${m.supportedReasoningEfforts.join("/")}`
          : `- ${m.name} (${m.id})`
      ),
    ];
    await this.deps.telegram.sendMessage(chatId, lines.join("\n"));
  }

  private async sendProjectMenu(chatId: number, page: number): Promise<void> {
    const menu = renderAntigravityProjectMenu(this.deps.newSessions.listProjects(), page, String(chatId), this.deps.tgStore);
    await this.deps.telegram.sendMessage(chatId, menu.text, menu.buttons);
  }

  private async sendModelMenu(chatId: number, page: number): Promise<void> {
    const models = await this.deps.newSessions.listModels();
    const current = this.deps.newSessions.getDefaultModel(String(chatId));
    const menu = renderAntigravityModelMenu(models, current, page, String(chatId), this.deps.tgStore);
    await this.deps.telegram.sendMessage(chatId, menu.text, menu.buttons);
  }

  private async requestPromptForProject(chatId: number, projectId: string, projectName: string, replyToMessageId?: number): Promise<void> {
    const promptMsg = await this.deps.telegram.sendForceReply(
      chatId,
      `💬 已选择 Antigravity 项目 [${projectName}]，请回复此消息输入第一轮需求。`,
      replyToMessageId,
      "输入第一轮需求"
    );
    this.deps.newSessions.createPendingPrompt(String(chatId), promptMsg.message_id, { id: projectId, name: projectName });
  }

  private async createSessionAndAcknowledge(updateId: number, chatId: number, projectId: string, prompt: string): Promise<void> {
    const outcome = await this.deps.newSessions.create(updateId, String(chatId), projectId, prompt);
    if (outcome.status === "failed") {
      const msg =
        outcome.errorCode === "project_missing"
          ? "Antigravity 项目已变化，请重新发送 /agy_new。"
          : outcome.errorCode === "model_unavailable"
            ? "已选择的 Antigravity 模型或思考等级不可用，请重新执行 /agy_model。"
            : "Antigravity 新会话创建被拒绝，未自动重试。";
      await this.deps.telegram.sendMessage(chatId, msg);
      return;
    }
    if (outcome.status === "delivery_unknown") {
      await this.deps.telegram.sendMessage(
        chatId,
        "Antigravity 新会话或首轮需求的投递状态不确定，请不要重复创建；请先在 Web 控制台中确认。"
      );
      return;
    }
    if (outcome.status === "duplicate") return;

    const split = this.deps.modelCatalog.splitVariantId(outcome.model?.modelId ?? null, outcome.model?.reasoningEffort ?? null);
    const modelLabel = split.model
      ? `${split.model.displayName ?? split.model.id}${split.reasoningEffort ? ` (${split.reasoningEffort})` : ""}`
      : "Antigravity 默认";

    const cb = createAntigravityCallback(this.deps.tgStore, String(chatId), "reply", { sessionId: outcome.sessionId }, Date.now(), 24 * 60 * 60_000);
    const token = cb.slice("agy:".length);

    try {
      const ack = await this.deps.telegram.sendMessage(
        chatId,
        [
          "🚀 已创建 Antigravity 会话并接收第一轮需求",
          `项目: ${outcome.project.name}`,
          `会话: ${outcome.sessionId}`,
          `模型: ${modelLabel}`,
        ].join("\n"),
        [[{ text: "💬 回复", callback_data: cb }]]
      );
      if (!this.deps.newSessions.acknowledge(updateId, String(chatId), ack.message_id, outcome.sessionId)) {
        this.deps.tgStore.expireCallback(token);
      }
    } catch {
      this.deps.tgStore.expireCallback(token);
    }
  }
}

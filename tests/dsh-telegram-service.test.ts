import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshReadOnlyBridge } from "../src/dsh/read-only-bridge.ts";
import { DshReplyRouter } from "../src/dsh/reply-router.ts";
import { DshNewSessionManager } from "../src/dsh/new-session-manager.ts";
import { TelegramService } from "../src/telegram/service.ts";
import type { AppConfig } from "../src/config.ts";
import type { BotCommand, InlineButton, TelegramMessage, TelegramUpdate } from "../src/telegram/client.ts";
import type { Logger } from "../src/logger.ts";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const config: AppConfig = {
  telegramBotToken: "token",
  allowedUserId: "123",
  allowedChatId: "456",
  dbPath: ":memory:",
  hookSocketPath: "/tmp/test.sock",
  codexStateDbPath: ":memory:",
  codexThreadHistoryDbPath: ":memory:",
  codexCliPath: "/bin/true",
  codexHome: "/tmp/codex-home",
  approvalTimeoutMs: 5_000,
  activeSessionTtlMs: 5_000,
  desktopPollIntervalMs: 5_000,
  telegramSummaryMaxChars: 1_000,
  logLevel: "error",
  dshReadOnlyEnabled: true,
  dshWriteEnabled: true,
  dshNotificationsEnabled: true,
  dshSocketPath: "/tmp/dsh.sock",
  dshTokenPath: "/tmp/dsh.token",
  dshPollIntervalMs: 10_000,
};

class MockTelegramClient {
  sent: Array<{ chatId: string | number; text: string; buttons?: InlineButton[][]; messageId: number }> = [];
  forceReplies: Array<{ chatId: string | number; text: string; replyTo?: number; messageId: number }> = [];
  edits: Array<{ chatId: string | number; messageId: number; text: string; buttons?: InlineButton[][] }> = [];
  answers: Array<{ id: string; text?: string }> = [];
  commands: BotCommand[] = [];
  nextMessageId = 100;

  async getUpdates(): Promise<TelegramUpdate[]> { return []; }

  async sendMessage(
    chatId: string | number,
    text: string,
    buttons?: InlineButton[][],
  ): Promise<TelegramMessage> {
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}), messageId });
    return { message_id: messageId, chat: { id: Number(chatId), type: "private" }, text };
  }

  async sendForceReply(
    chatId: string | number,
    text: string,
    replyTo?: number,
  ): Promise<TelegramMessage> {
    const messageId = this.nextMessageId++;
    this.forceReplies.push({ chatId, text, ...(replyTo === undefined ? {} : { replyTo }), messageId });
    return { message_id: messageId, chat: { id: Number(chatId), type: "private" }, text };
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    buttons?: InlineButton[][],
  ): Promise<TelegramMessage> {
    this.edits.push({ chatId, messageId, text, ...(buttons ? { buttons } : {}) });
    return { message_id: messageId, chat: { id: Number(chatId), type: "private" }, text };
  }

  async editMessageReplyMarkup(): Promise<unknown> { return true; }

  async answerCallbackQuery(id: string, text?: string): Promise<true> {
    this.answers.push({ id, ...(text ? { text } : {}) });
    return true;
  }

  async setMyCommands(commands: BotCommand[]): Promise<boolean> {
    this.commands = [...commands];
    return true;
  }
}

function messageUpdate(updateId: number, text: string, replyTo?: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 1_000 + updateId,
      from: { id: 123 },
      chat: { id: 456, type: "private" },
      text,
      ...(replyTo === undefined ? {} : {
        reply_to_message: { message_id: replyTo, chat: { id: 456, type: "private" } },
      }),
    },
  };
}

function callbackUpdate(updateId: number, data: string, sourceMessageId = 90): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: 123 },
      data,
      message: { message_id: sourceMessageId, chat: { id: 456, type: "private" } },
    },
  };
}

function setup() {
  const state = new StateDb(":memory:");
  const desktopStore = new DesktopMessageStore(state);
  const dshStore = new DshBridgeStore(state);
  const hostCalls: Array<{ op: string; args: unknown[] }> = [];
  const host = {
    health: async () => ({ status: "mounted" as const, protocol: 1, connectorVersion: "0.4.0" }),
    listProjects: async () => [
      { id: "workspace-alpha-long-private-id", title: "Alpha", sessionCount: 1 },
      { id: "workspace-beta-long-private-id", title: "Beta", sessionCount: 0 },
    ],
    listModels: async () => ({
      default: { provider: "provider-secret-id", model: "model-default-secret-id" },
      groups: [{
        id: "provider-secret-id",
        name: "Provider",
        models: [
          { id: "model-default-secret-id", name: "Default Model" },
          { id: "model-alt-secret-id", name: "Alt Model" },
        ],
      }],
      failureCount: 0,
    }),
    createSession: async (...args: unknown[]) => {
      hostCalls.push({ op: "create", args });
      return { status: "accepted" as const, sessionId: args[1] as string, agentPreset: null };
    },
    selectModel: async (...args: unknown[]) => {
      hostCalls.push({ op: "model", args });
      return { status: "accepted" as const, selected: args[1] as any };
    },
    submitPrompt: async (...args: unknown[]) => {
      hostCalls.push({ op: "prompt", args });
      return { status: "accepted" as const };
    },
  };
  const dshReadOnly = new DshReadOnlyBridge(host, dshStore);
  const dshReply = new DshReplyRouter(host as any, dshStore);
  const dshNew = new DshNewSessionManager(host as any, dshStore, () => 10_000);
  const client = new MockTelegramClient();
  const codexCalls: unknown[][] = [];
  const codexQueue = {
    queue: async (...args: unknown[]) => {
      codexCalls.push(args);
      return { status: "delivered" as const, exitCode: 0, errorCode: null };
    },
  };
  const service = new TelegramService(
    config,
    state,
    client as any,
    {} as any,
    {} as any,
    desktopStore,
    codexQueue as any,
    logger,
    undefined,
    undefined,
    dshReadOnly,
    dshStore,
    dshReply,
    dshNew,
  );
  return { state, desktopStore, dshStore, hostCalls, codexCalls, host, client, dshNew, service };
}

describe("Telegram dsh full integration", () => {
  test("registers full dsh command set and reports complete mode", async () => {
    const { state, client, service } = setup();
    try {
      await (service as any).syncBotCommands();
      expect(client.commands.map((item) => item.command)).toEqual([
        "status", "dsh_status", "dsh_projects", "dsh_model", "dsh_new",
      ]);
      await (service as any).processUpdate(messageUpdate(1, "/dsh_status"));
      expect(client.sent.at(-1)?.text).toContain("完整模式");
      expect(client.sent.at(-1)?.text).toContain("Connector: 0.4.0");
      expect(client.sent.at(-1)?.text).toContain("回复: available");
      expect(client.sent.at(-1)?.text).toContain("新建会话: available");
    } finally {
      state.close();
    }
  });

  test("/dsh_new uses opaque project callback then durable ForceReply creation", async () => {
    const { state, client, hostCalls, dshStore, service } = setup();
    try {
      await (service as any).processUpdate(messageUpdate(2, "/dsh_new"));
      const projectMenu = client.sent.at(-1)!;
      const callbackData = projectMenu.buttons?.[0]?.[0]?.callback_data;
      expect(callbackData).toMatch(/^dsh:[A-Za-z0-9_-]+$/);
      expect(callbackData!.length).toBeLessThanOrEqual(64);
      expect(callbackData).not.toContain("workspace-alpha-long-private-id");

      await (service as any).processUpdate(callbackUpdate(3, callbackData!, projectMenu.messageId));
      const promptMessageId = client.forceReplies.at(-1)?.messageId;
      expect(promptMessageId).toBeDefined();
      expect(client.forceReplies.at(-1)?.text).toContain("Alpha");

      await (service as any).processUpdate(messageUpdate(4, "build this", promptMessageId));
      expect(hostCalls.map((call) => call.op)).toEqual(["create", "prompt"]);
      const sessionId = hostCalls[0]?.args[1] as string;
      expect(sessionId).toMatch(/^session-sea-bridge-[a-f0-9]{24}$/);
      expect(hostCalls[0]?.args).toEqual(["workspace-alpha-long-private-id", sessionId]);
      expect(hostCalls[1]?.args).toEqual([sessionId, "sea-bridge-new-4", "build this"]);
      const ack = client.sent.at(-1)!;
      expect(ack.text).toContain("已创建 dsh Web 会话并接收第一轮需求");
      expect(ack.buttons?.[0]?.[0]?.callback_data).toMatch(/^dsh:/);
      expect(dshStore.getCreation(4)?.status).toBe("acknowledged");
      expect(dshStore.findMessageLink("456", ack.messageId)?.sessionId).toBe(sessionId);
      expect(dshStore.getCreatedSession(sessionId)?.baselinePending).toBe(true);
    } finally {
      state.close();
    }
  });

  test("expires a creation Reply token when acknowledgement mapping fails", async () => {
    const { state, client, dshStore, dshNew, service } = setup();
    try {
      dshNew.acknowledge = () => false;
      await (service as any).processUpdate(messageUpdate(
        8,
        "/dsh_new workspace-alpha-long-private-id create with broken ack mapping",
      ));
      const ack = client.sent.at(-1)!;
      const callbackData = ack.buttons?.[0]?.[0]?.callback_data ?? "";
      expect(callbackData).toMatch(/^dsh:/);
      expect(dshStore.getCallbackStatus(callbackData.slice(4))).toBe("expired");
      expect(dshStore.findMessageLink("456", ack.messageId)).toBeNull();
    } finally {
      state.close();
    }
  });

  test("/dsh_model stores opaque model selection and applies it before first prompt", async () => {
    const { state, client, hostCalls, dshNew, service } = setup();
    try {
      await (service as any).processUpdate(messageUpdate(10, "/dsh_model"));
      const menu = client.sent.at(-1)!;
      const modelButton = menu.buttons?.flat().find((button) => button.text.includes("Alt Model"));
      expect(modelButton?.callback_data).toMatch(/^dsh:/);
      expect(modelButton?.callback_data).not.toContain("model-alt-secret-id");

      await (service as any).processUpdate(callbackUpdate(11, modelButton!.callback_data, menu.messageId));
      expect(dshNew.getDefaultModel("456")).toEqual({
        provider: "provider-secret-id",
        model: "model-alt-secret-id",
      });

      await (service as any).processUpdate(messageUpdate(
        12,
        "/dsh_new workspace-alpha-long-private-id use selected model",
      ));
      expect(hostCalls.map((call) => call.op)).toEqual(["create", "model", "prompt"]);
      const sessionId = hostCalls[0]?.args[1] as string;
      expect(sessionId).toMatch(/^session-sea-bridge-[a-f0-9]{24}$/);
      expect(hostCalls[1]?.args).toEqual([
        sessionId,
        { provider: "provider-secret-id", model: "model-alt-secret-id" },
      ]);
      expect(hostCalls[2]?.args?.[0]).toBe(sessionId);
    } finally {
      state.close();
    }
  });

  test("dsh reply button creates an exact prompt mapping and reply reaches only that session", async () => {
    const { state, client, dshStore, hostCalls, codexCalls, service } = setup();
    try {
      dshStore.linkMessage({
        chatId: "456",
        messageId: 300,
        sessionId: "session-target",
        eventKind: "completed",
        eventFingerprint: "event-target",
      });
      const token = (await import("../src/dsh/menu-ui.ts")).createDshCallback(
        dshStore,
        "456",
        "reply",
        { sessionId: "session-target" },
      );
      await (service as any).processUpdate(callbackUpdate(20, token, 300));
      const forceId = client.forceReplies.at(-1)?.messageId;
      expect(forceId).toBeDefined();
      expect(dshStore.findMessageLink("456", forceId!)?.sessionId).toBe("session-target");

      await (service as any).processUpdate(messageUpdate(21, "continue dsh", forceId));
      expect(hostCalls.at(-1)).toEqual({
        op: "prompt",
        args: ["session-target", "sea-bridge-tg-21", "continue dsh"],
      });
      expect(codexCalls).toHaveLength(0);
      expect(client.sent.at(-1)?.text).toContain("已投递到对应的 dsh Web 会话");
    } finally {
      state.close();
    }
  });

  test("plain text without reply remains latest Codex and provider collision writes nowhere", async () => {
    const { state, desktopStore, dshStore, hostCalls, codexCalls, client, service } = setup();
    try {
      desktopStore.link({
        chatId: "456",
        messageId: 400,
        threadId: "thread-latest",
        turnId: null,
        eventKind: "completed",
        eventFingerprint: "codex-latest",
      });
      await (service as any).processUpdate(messageUpdate(30, "plain direct"));
      expect(codexCalls).toHaveLength(1);
      expect(codexCalls[0]?.[0]).toBe("thread-latest");
      expect(hostCalls).toHaveLength(0);

      desktopStore.link({
        chatId: "456",
        messageId: 401,
        threadId: "thread-conflict",
        turnId: null,
        eventKind: "completed",
        eventFingerprint: "codex-conflict",
      });
      dshStore.linkMessage({
        chatId: "456",
        messageId: 401,
        sessionId: "session-conflict",
        eventKind: "completed",
        eventFingerprint: "dsh-conflict",
      });
      await (service as any).processUpdate(messageUpdate(31, "must block", 401));
      expect(hostCalls).toHaveLength(0);
      expect(codexCalls).toHaveLength(1);
      expect(client.sent.at(-1)?.text).toContain("同时存在 Codex 与 dsh 映射");
    } finally {
      state.close();
    }
  });

  test("consumed callback token cannot execute a second write action", async () => {
    const { state, dshStore, hostCalls, service, client } = setup();
    try {
      const token = (await import("../src/dsh/menu-ui.ts")).createDshCallback(
        dshStore,
        "456",
        "model.select",
        { provider: "provider-secret-id", model: "model-alt-secret-id" },
      );
      await (service as any).processUpdate(callbackUpdate(40, token));
      await (service as any).processUpdate(callbackUpdate(41, token));
      expect(hostCalls).toHaveLength(0);
      expect(client.answers.at(-1)?.text).toContain("已过期或已使用");
    } finally {
      state.close();
    }
  });
});

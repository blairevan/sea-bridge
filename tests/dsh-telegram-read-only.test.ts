import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshReadOnlyBridge } from "../src/dsh/read-only-bridge.ts";
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
  dshWriteEnabled: false,
  dshNotificationsEnabled: false,
  dshSocketPath: "/tmp/dsh.sock",
  dshTokenPath: "/tmp/dsh.token",
  dshPollIntervalMs: 10_000,
};

class MockTelegramClient {
  sent: Array<{ chatId: string | number; text: string; buttons?: InlineButton[][] }> = [];
  commands: BotCommand[] = [];
  nextMessageId = 100;

  async sendMessage(chatId: string | number, text: string, buttons?: InlineButton[][]): Promise<TelegramMessage> {
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}) });
    return { message_id: this.nextMessageId++, chat: { id: Number(chatId), type: "private" }, text };
  }

  async setMyCommands(commands: BotCommand[]): Promise<boolean> {
    this.commands = [...commands];
    return true;
  }

  async answerCallbackQuery(): Promise<true> { return true; }
  async getUpdates(): Promise<TelegramUpdate[]> { return []; }
}

function update(updateId: number, text: string, replyTo?: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1_000,
      from: { id: 123 },
      chat: { id: 456, type: "private" },
      text,
      ...(replyTo !== undefined ? {
        reply_to_message: { message_id: replyTo, chat: { id: 456, type: "private" } },
      } : {}),
    },
  };
}

function setup() {
  const state = new StateDb(":memory:");
  const desktop = new DesktopMessageStore(state);
  const dshStore = new DshBridgeStore(state);
  const host = {
    health: async () => ({ status: "mounted" as const, protocol: 1, connectorVersion: "0.3.0" }),
    listProjects: async () => [
      { id: "p1", title: "Alpha", sessionCount: 2 },
      { id: "p2", title: "Beta", sessionCount: 1 },
    ],
    listModels: async () => ({
      default: { provider: "provider-a", model: "model-a" },
      groups: [{ id: "provider-a", name: "Provider A", models: [
        { id: "model-a", name: "Model A" },
        { id: "model-b", name: "Model B" },
      ] }],
      failureCount: 0,
    }),
  };
  const dsh = new DshReadOnlyBridge(host, dshStore);
  const client = new MockTelegramClient();
  const queueCalls: Array<{ threadId: string; text: string }> = [];
  const queue = {
    queue: async (threadId: string, text: string) => {
      queueCalls.push({ threadId, text });
      return { status: "delivered" as const, exitCode: 0, errorCode: null };
    },
  };
  const service = new TelegramService(
    config,
    state,
    client as any,
    {} as any,
    {} as any,
    desktop,
    queue as any,
    logger,
    undefined,
    undefined,
    dsh,
  );
  return { state, desktop, dshStore, client, queueCalls, service };
}

describe("Telegram dsh read-only integration", () => {
  test("registers and serves dsh read-only commands without mutation controls", async () => {
    const { state, client, service } = setup();
    try {
      await (service as any).syncBotCommands();
      expect(client.commands.map((item) => item.command)).toEqual([
        "status", "dsh_status", "dsh_projects", "dsh_model",
      ]);

      await (service as any).processUpdate(update(1, "/dsh_status"));
      expect(client.sent.at(-1)?.text).toContain("已连接（只读模式）");
      expect(client.sent.at(-1)?.text).toContain("回复: unavailable");

      await (service as any).processUpdate(update(2, "/dsh_projects"));
      expect(client.sent.at(-1)?.text).toContain("Alpha（2 个会话）");

      await (service as any).processUpdate(update(3, "/dsh_model"));
      expect(client.sent.at(-1)?.text).toContain("只读，当前不支持切换");
      expect(client.sent.at(-1)?.buttons).toBeUndefined();
    } finally {
      state.close();
    }
  });

  test("blocks an exact dsh notification reply without calling the Codex queue", async () => {
    const { state, dshStore, client, queueCalls, service } = setup();
    try {
      dshStore.linkMessage({
        chatId: "456",
        messageId: 50,
        sessionId: "session-dsh",
        eventKind: "completed",
        eventFingerprint: "dsh-fp",
      });

      await (service as any).processUpdate(update(4, "do something", 50));

      expect(queueCalls).toEqual([]);
      expect(client.sent.at(-1)?.text).toContain("dsh Web 只读通知");
      expect(client.sent.at(-1)?.text).toContain("没有发送到 dsh");
    } finally {
      state.close();
    }
  });

  test("fails closed if the same Telegram message maps to both providers", async () => {
    const { state, desktop, dshStore, client, queueCalls, service } = setup();
    try {
      desktop.link({
        chatId: "456",
        messageId: 60,
        threadId: "thread-codex",
        turnId: null,
        eventKind: "completed",
        eventFingerprint: "codex-fp",
      });
      dshStore.linkMessage({
        chatId: "456",
        messageId: 60,
        sessionId: "session-dsh",
        eventKind: "completed",
        eventFingerprint: "dsh-conflict",
      });

      await (service as any).processUpdate(update(5, "conflict", 60));

      expect(queueCalls).toEqual([]);
      expect(client.sent.at(-1)?.text).toContain("同时存在 Codex 与 dsh 映射");
    } finally {
      state.close();
    }
  });

  test("keeps no-reply plain text on the existing latest-Codex behavior", async () => {
    const { state, desktop, queueCalls, service } = setup();
    try {
      desktop.link({
        chatId: "456",
        messageId: 70,
        threadId: "thread-latest",
        turnId: null,
        eventKind: "completed",
        eventFingerprint: "latest-fp",
      });

      await (service as any).processUpdate(update(6, "plain text"));

      expect(queueCalls).toHaveLength(1);
      expect(queueCalls[0]?.threadId).toBe("thread-latest");
    } finally {
      state.close();
    }
  });
});

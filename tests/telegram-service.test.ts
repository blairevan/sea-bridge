import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { TelegramService } from "../src/telegram/service.ts";
import type { AppConfig } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";
import type { TelegramUpdate, TelegramMessage, InlineButton, BotCommand } from "../src/telegram/client.ts";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface SentMessage {
  chatId: string | number;
  text: string;
  buttons?: InlineButton[][];
  forceReply?: boolean;
  replyToMessageId?: number;
}

class MockTelegramClient {
  answeredCallbacks: Array<{ id: string; text?: string }> = [];
  sentMessages: SentMessage[] = [];
  registeredCommands: BotCommand[] = [];
  nextMessageId = 100;

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }
  async answerCallbackQuery(id: string, text?: string): Promise<true> {
    const entry: { id: string; text?: string } = { id };
    if (text !== undefined) entry.text = text;
    this.answeredCallbacks.push(entry);
    return true;
  }
  async setMyCommands(commands: BotCommand[]): Promise<boolean> {
    this.registeredCommands = [...commands];
    return true;
  }
  async sendMessage(chatId: string | number, text: string, buttons?: InlineButton[][], forceReply = false, replyToMessageId?: number): Promise<TelegramMessage> {
    const msg: SentMessage = { chatId, text, forceReply };
    if (buttons !== undefined) msg.buttons = buttons;
    if (replyToMessageId !== undefined) msg.replyToMessageId = replyToMessageId;
    this.sentMessages.push(msg);
    return {
      message_id: this.nextMessageId++,
      chat: { id: Number(chatId), type: "private" },
      text,
    };
  }
}

describe("TelegramService - reply callback", () => {
  test("handles reply callback by answering callback and sending prompt with forceReply", async () => {
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    const client = new MockTelegramClient();
    const config: AppConfig = {
      telegramBotToken: "token",
      allowedUserId: "123",
      allowedChatId: "456",
      dbPath: ":memory:",
      hookSocketPath: "/tmp/test.sock",
      codexStateDbPath: ":memory:",
      codexThreadHistoryDbPath: ":memory:",
      codexCliPath: "/bin/true",
      approvalTimeoutMs: 5000,
      activeSessionTtlMs: 5000,
      desktopPollIntervalMs: 5000,
      telegramSummaryMaxChars: 1000,
      logLevel: "error",
    };

    const service = new TelegramService(
      config,
      state,
      client as any,
      {} as any,
      {} as any,
      messages,
      {} as any,
      logger,
    );

    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 123 },
        data: "reply:thread-xyz",
        message: {
          message_id: 88,
          chat: { id: 456, type: "private" },
        },
      },
    };

    // Feed the update to service via processUpdate
    await (service as any).processUpdate(update);

    expect(client.answeredCallbacks).toEqual([{ id: "cb-1" }]);
    expect(client.sentMessages.length).toBe(1);
    const sent = client.sentMessages[0]!;
    expect(sent.chatId).toBe(456);
    expect(sent.text).toBe("💬 请回复此消息，内容将投递给该 Codex 会话：");
    expect(sent.forceReply).toBe(true);
    expect(sent.replyToMessageId).toBe(88);

    // Verify prompt message was linked in DesktopMessageStore
    const link = messages.findLink("456", 100);
    expect(link).not.toBeNull();
    expect(link?.threadId).toBe("thread-xyz");
    expect(link?.eventKind).toBe("reply_prompt");

    state.close();
  });

  test("delivers message with thread title included in success response", async () => {
    const state = new StateDb(":memory:");
    const messages = new DesktopMessageStore(state);
    const client = new MockTelegramClient();
    const config: AppConfig = {
      telegramBotToken: "token",
      allowedUserId: "123",
      allowedChatId: "456",
      dbPath: ":memory:",
      hookSocketPath: "/tmp/test.sock",
      codexStateDbPath: ":memory:",
      codexThreadHistoryDbPath: ":memory:",
      codexCliPath: "/bin/true",
      approvalTimeoutMs: 5000,
      activeSessionTtlMs: 5000,
      desktopPollIntervalMs: 5000,
      telegramSummaryMaxChars: 1000,
      logLevel: "error",
    };

    messages.link({
      chatId: "456",
      messageId: 50,
      threadId: "thread-xyz",
      turnId: null,
      eventKind: "completed",
      eventFingerprint: "fp-50",
    });

    const queueClient = {
      queue: async () => ({ status: "delivered" as const, exitCode: 0, errorCode: null }),
    };

    const mockThreadStore = {
      listActive: () => [],
      getThread: (id: string) => id === "thread-xyz" ? { id: "thread-xyz", rolloutPath: "", title: "我的会话标题", updatedAtMs: 0 } : null,
    };

    const service = new TelegramService(
      config,
      state,
      client as any,
      {} as any,
      {} as any,
      messages,
      queueClient as any,
      logger,
      mockThreadStore,
    );

    const update: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 60,
        from: { id: 123 },
        chat: { id: 456, type: "private" },
        text: "hello world",
      },
    };

    await (service as any).processUpdate(update);

    expect(client.sentMessages.length).toBe(1);
    expect(client.sentMessages[0]?.text).toBe("已投递到对应的 Codex Desktop 会话：我的会话标题");

    state.close();
  });

  test("syncs bot commands on startup", async () => {
    const state = new StateDb(":memory:");
    const client = new MockTelegramClient();
    const messages = new DesktopMessageStore(state);
    const config: AppConfig = {
      telegramBotToken: "token",
      allowedUserId: "123",
      allowedChatId: "456",
      dbPath: ":memory:",
      hookSocketPath: "/tmp/test.sock",
      approvalTimeoutMs: 1000,
      activeSessionTtlMs: 1000,
      codexStateDbPath: "/tmp/state.sqlite",
      codexThreadHistoryDbPath: "/tmp/history.sqlite",
      codexCliPath: "/tmp/codex",
      desktopPollIntervalMs: 1000,
      telegramSummaryMaxChars: 1000,
      logLevel: "error",
    };
    const service = new TelegramService(
      config,
      state,
      client as any,
      {} as any,
      {} as any,
      messages,
      {} as any,
      logger,
    );

    await (service as any).syncBotCommands();
    expect(client.registeredCommands).toEqual([
      { command: "status", description: "查看服务能力与会话状态" },
    ]);

    state.close();
  });
});

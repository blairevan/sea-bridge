import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { NewThreadStateStore } from "../src/state/new-thread-state-store.ts";
import { NewThreadManager } from "../src/desktop/new-thread-manager.ts";
import { TelegramService } from "../src/telegram/service.ts";
import type { AppConfig } from "../src/config.ts";
import type { InlineButton, TelegramMessage, TelegramUpdate } from "../src/telegram/client.ts";
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
  codexCliPath: "/codex",
  approvalTimeoutMs: 5000,
  activeSessionTtlMs: 5000,
  desktopPollIntervalMs: 5000,
  telegramSummaryMaxChars: 1000,
  logLevel: "error",
};

class MockTelegramClient {
  nextMessageId = 100;
  sent: Array<{ chatId: string | number; text: string; buttons?: InlineButton[][] }> = [];
  forceReplies: Array<{ chatId: string | number; text: string; replyTo?: number; placeholder?: string; messageId: number }> = [];
  answered: Array<{ id: string; text?: string }> = [];
  edits: Array<{ chatId: string | number; messageId: number; text: string; buttons?: InlineButton[][] }> = [];

  async getUpdates(): Promise<TelegramUpdate[]> { return []; }

  async sendMessage(chatId: string | number, text: string, buttons?: InlineButton[][]): Promise<TelegramMessage> {
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}) });
    return { message_id: this.nextMessageId++, chat: { id: Number(chatId), type: "private" }, text };
  }

  async sendForceReply(
    chatId: string | number,
    text: string,
    replyTo?: number,
    placeholder?: string,
  ): Promise<TelegramMessage> {
    const messageId = this.nextMessageId++;
    this.forceReplies.push({ chatId, text, ...(replyTo !== undefined ? { replyTo } : {}), ...(placeholder ? { placeholder } : {}), messageId });
    return { message_id: messageId, chat: { id: Number(chatId), type: "private" }, text };
  }

  async answerCallbackQuery(id: string, text?: string): Promise<true> {
    this.answered.push({ id, ...(text ? { text } : {}) });
    return true;
  }

  async editMessageText(chatId: string | number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<TelegramMessage> {
    this.edits.push({ chatId, messageId, text, ...(buttons ? { buttons } : {}) });
    return { message_id: messageId, chat: { id: Number(chatId), type: "private" }, text };
  }

  async editMessageReplyMarkup(): Promise<unknown> { return true; }
}

function setup() {
  const state = new StateDb(":memory:");
  const messages = new DesktopMessageStore(state);
  const newState = new NewThreadStateStore(state);
  const starts: any[] = [];
  const appServer = {
    listProjects: async () => [
      { index: 1, id: "p1", name: "sea-bridge", roots: ["/repo"], primaryRoot: "/repo", position: 0 },
      { index: 2, id: "p2", name: "aining", roots: ["/aining"], primaryRoot: "/aining", position: 1 },
    ],
    listModels: async () => [
      { id: "gpt-5-codex", displayName: "GPT-5 Codex" },
      { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
    ],
    startThreadAndTurn: async (params: any) => {
      const threadId = "thread-" + (starts.length + 1);
      const { onThreadStarted, ...recorded } = params;
      starts.push(recorded);
      onThreadStarted?.(threadId);
      return {
        threadId,
        turnId: "turn-" + starts.length,
        projectId: params.projectId,
        cwd: params.cwd,
        model: params.model ?? "gpt-5-codex",
      };
    },
  };
  const manager = new NewThreadManager(appServer as any, newState, {
    pathExists: () => true,
    now: () => 1_000,
    onThreadStarted: (threadId) => messages.registerCreatedThread(threadId),
  });
  const client = new MockTelegramClient();
  const service = new TelegramService(
    config,
    state,
    client as any,
    {} as any,
    {} as any,
    messages,
    {} as any,
    logger,
    undefined,
    manager,
  );
  return { state, messages, newState, starts, manager, client, service };
}

function messageUpdate(updateId: number, text: string, replyTo?: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 10,
      from: { id: 123 },
      chat: { id: 456, type: "private" },
      text,
      ...(replyTo !== undefined ? {
        reply_to_message: { message_id: replyTo, chat: { id: 456, type: "private" } },
      } : {}),
    },
  };
}

describe("Telegram project new-thread flow", () => {
  test("/projects and /model render live app-server data", async () => {
    const { state, client, service } = setup();

    await (service as any).processUpdate(messageUpdate(1, "/projects"));
    expect(client.sent.at(-1)?.text).toContain("[1] sea-bridge");

    await (service as any).processUpdate(messageUpdate(2, "/model"));
    expect(client.sent.at(-1)?.buttons?.flat().some((button) => button.callback_data === "model:set:gpt-5.3-codex")).toBe(true);

    state.close();
  });

  test("/new <index> <prompt> starts first turn and links the success message", async () => {
    const { state, starts, messages, service } = setup();

    await (service as any).processUpdate(messageUpdate(3, "/new 1 review this"));

    expect(starts).toEqual([{
      projectId: "p1",
      cwd: "/repo",
      prompt: "review this",
    }]);
    expect(messages.getCursor("thread-1")?.byteOffset).toBe(0);
    expect(messages.findLatestLink("456")?.threadId).toBe("thread-1");
    expect(messages.findLatestLink("456")?.eventKind).toBe("thread_created");

    state.close();
  });

  test("/new project picker persists ForceReply state and consumes it once", async () => {
    const { state, starts, client, service } = setup();

    await (service as any).processUpdate(messageUpdate(4, "/new"));
    const pickerMessageId = 100;
    await (service as any).processUpdate({
      update_id: 5,
      callback_query: {
        id: "cb-project",
        from: { id: 123 },
        data: "new:proj:p1",
        message: { message_id: pickerMessageId, chat: { id: 456, type: "private" } },
      },
    });

    const promptMessageId = client.forceReplies[0]?.messageId;
    expect(promptMessageId).toBeDefined();

    await (service as any).processUpdate(messageUpdate(6, "build it", promptMessageId));
    expect(starts).toHaveLength(1);
    expect(starts[0].projectId).toBe("p1");
    expect(starts[0].prompt).toBe("build it");

    await (service as any).processUpdate(messageUpdate(11, "build it again", promptMessageId));
    expect(starts).toHaveLength(1);
    expect(client.sent.at(-1)?.text).toContain("已经使用过");

    state.close();
  });

  test("model callback stores preference and applies it to a new thread", async () => {
    const { state, starts, newState, service } = setup();

    await (service as any).processUpdate({
      update_id: 7,
      callback_query: {
        id: "cb-model",
        from: { id: 123 },
        data: "model:set:gpt-5.3-codex",
        message: { message_id: 99, chat: { id: 456, type: "private" } },
      },
    });
    expect(newState.getDefaultModel("456")).toBe("gpt-5.3-codex");

    await (service as any).processUpdate(messageUpdate(8, "/new 1 test model"));
    expect(starts[0].model).toBe("gpt-5.3-codex");

    state.close();
  });

  test("marks direct /new as processed when project discovery is temporarily unavailable", async () => {
    const { state, manager, client, service } = setup();
    (manager as any).appServer.listProjects = async () => {
      throw new Error("app-server unavailable");
    };

    await (service as any).processUpdate(messageUpdate(9, "/new 1 should not block"));

    const row = state.db.query("SELECT status FROM telegram_updates WHERE update_id=9").get() as { status: string };
    expect(row.status).toBe("processed");
    expect(client.sent.at(-1)?.text).toContain("项目列表暂不可用");

    state.close();
  });

  test("marks model callback as processed when live model discovery fails", async () => {
    const { state, manager, client, service } = setup();
    (manager as any).appServer.listModels = async () => {
      throw new Error("app-server unavailable");
    };

    await (service as any).processUpdate({
      update_id: 10,
      callback_query: {
        id: "cb-model-fail",
        from: { id: 123 },
        data: "model:set:gpt-5.3-codex",
        message: { message_id: 99, chat: { id: 456, type: "private" } },
      },
    });

    const row = state.db.query("SELECT status FROM telegram_updates WHERE update_id=10").get() as { status: string };
    expect(row.status).toBe("processed");
    expect(client.sent.at(-1)?.text).toContain("模型列表暂不可用");

    state.close();
  });
});

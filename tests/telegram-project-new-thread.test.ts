import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { NewThreadStateStore } from "../src/state/new-thread-state-store.ts";
import { NewThreadManager } from "../src/desktop/new-thread-manager.ts";
import { TelegramService } from "../src/telegram/service.ts";
import type { AppConfig } from "../src/config.ts";
import type { InlineButton, TelegramMessage, TelegramUpdate } from "../src/telegram/client.ts";
import type { Logger } from "../src/logger.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const config: AppConfig = {
  telegramBotToken: "token",
  allowedUserId: "123",
  allowedChatId: "456",
  dbPath: ":memory:",
  hookSocketPath: "/tmp/test.sock",
  codexCliPath: "/codex",
  codexHome: "/tmp/codex-home",
  approvalTimeoutMs: 5000,
  activeSessionTtlMs: 5000,
  desktopPollIntervalMs: 5000,
  telegramSummaryMaxChars: 1000,
  logLevel: "error",
  dshReadOnlyEnabled: false,
  dshWriteEnabled: false,
  dshNotificationsEnabled: false,
  dshSocketPath: "/tmp/dsh.sock",
  dshTokenPath: "/tmp/dsh.token",
  dshPollIntervalMs: 10_000,
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

/** Compose a deterministic Telegram creation flow with optional persistent state. */
function setup(path = ":memory:") {
  const state = new StateDb(path);
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

test("a mapping failure after creation cannot replay the same Telegram update", async () => {
  const { state, messages, starts, service } = setup();
  const process = service as unknown as { processUpdate(update: TelegramUpdate): Promise<void> };
  const link = messages.link.bind(messages); let fail = true;
  messages.link = (input) => { if (fail) { fail = false; throw new Error("fixture persistence failed"); } return link(input); };
  try {
    const update = messageUpdate(900, "/new 1 hello");
    await process.processUpdate(update).catch(() => {});
    await process.processUpdate(update);
    expect(starts).toHaveLength(1);
  } finally { state.close(); }
});

test("an interrupted creation claim survives update retry without dispatching again", async () => {
  const { state, starts, client, service } = setup();
  try {
    state.db.query("INSERT INTO codex_creation_requests(telegram_update_id,status,thread_id,created_at,updated_at) VALUES(901,'dispatching','known-thread',1,1)").run();
    const process = service as unknown as { processUpdate(update: TelegramUpdate): Promise<void> };
    await process.processUpdate(messageUpdate(901, "/new 1 hello"));
    expect(starts).toHaveLength(0); expect(client.sent.at(-1)?.text).toContain("known-thread");
    expect(client.sent.at(-1)?.text).toContain("不会自动重复创建");
  } finally { state.close(); }
});

test("a completed creation survives a restart before update acknowledgement", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-creation-restart-")); const path = join(root, "state.db");
  const first = setup(path);
  try {
    const process = first.service as unknown as { processUpdate(update: TelegramUpdate): Promise<void> };
    await process.processUpdate(messageUpdate(903, "/new 1 hello"));
    first.state.db.query("UPDATE telegram_updates SET status='failed' WHERE update_id=903").run();
  } finally { first.state.close(); }
  const second = setup(path);
  try {
    const process = second.service as unknown as { processUpdate(update: TelegramUpdate): Promise<void> };
    await process.processUpdate(messageUpdate(903, "/new 1 hello"));
    expect(second.starts).toHaveLength(0); expect(second.client.sent.at(-1)?.text).toContain("thread-1");
  } finally { second.state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("creation callback persistence failures keep the claim and never dispatch a second thread", async () => {
  for (const condition of ["NEW.thread_id IS NOT NULL", "1"]) {
    const { state, starts, service } = setup();
    const process = service as unknown as { processUpdate(update: TelegramUpdate): Promise<void> };
    try {
      state.db.exec(`CREATE TRIGGER reject_creation_update BEFORE UPDATE ON codex_creation_requests WHEN ${condition} BEGIN SELECT RAISE(ABORT,'fixture'); END`);
      const update = messageUpdate(904, "/new 1 hello");
      await process.processUpdate(update).catch(() => {});
      state.db.exec("DROP TRIGGER reject_creation_update");
      await process.processUpdate(update); expect(starts).toHaveLength(1);
    } finally { state.close(); }
  }
});

test("Telegram stop waits for an in-flight update before state closure", async () => {
  const { state, client, service } = setup();
  let release!: () => void; let enter!: () => void; let polled = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  client.getUpdates = async () => { if (polled) throw new Error("unexpected second poll"); polled = true; return [messageUpdate(902, "/new 1 hello")]; };
  const send = client.sendMessage.bind(client);
  client.sendMessage = async (chatId, text, buttons) => { enter(); await held; return send(chatId, text, buttons); };
  try {
    const running = service.run(); await entered;
    let stopped = false; const stopping = service.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve(); expect(stopped).toBe(false);
    release(); await stopping; await running;
    expect(state.db.query("SELECT status FROM telegram_updates WHERE update_id=902").get()).toEqual({ status: "processed" });
  } finally { release(); await service.stop(); state.close(); }
});

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
    const { state, starts, messages, client, service } = setup();

    await (service as any).processUpdate(messageUpdate(3, "/new 1 review this"));

    expect(starts).toEqual([{
      projectId: "p1",
      cwd: "/repo",
      prompt: "[Telegram init]\nreview this",
    }]);
    expect(messages.getCursor("thread-1")?.byteOffset).toBe(0);
    expect(messages.findLatestLink("456")?.threadId).toBe("thread-1");
    expect(messages.findLatestLink("456")?.eventKind).toBe("thread_created");
    expect(client.sent.at(-1)?.text).toContain("可能会提示“在另一个应用中打开”");
    expect(client.sent.at(-1)?.text).toContain("待收到任务结束通知后");

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
    expect(starts[0].prompt).toBe("[Telegram init]\nbuild it");

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

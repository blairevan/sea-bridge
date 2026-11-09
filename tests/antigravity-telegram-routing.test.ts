import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AntigravityModelCatalog } from "../src/antigravity/model-catalog.ts";
import { AntigravityNewSessionManager } from "../src/antigravity/new-session-manager.ts";
import { AntigravityReplyRouter } from "../src/antigravity/reply-router.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";
import { AntigravityTelegramStore } from "../src/antigravity/telegram-store.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import type { StateDb } from "../src/state/db.ts";
import { routeProviderReply } from "../src/telegram/provider-reply-router.ts";

const modelsFixture = readFileSync(
  path.join(import.meta.dir, "fixtures", "antigravity-acp", "agy-models.txt"),
  "utf8"
);

function createFakeStateDb(): StateDb {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE desktop_message_links (
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      event_kind TEXT NOT NULL,
      event_fingerprint TEXT NOT NULL UNIQUE,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (telegram_chat_id, telegram_message_id)
    );
    CREATE TABLE desktop_deliveries (
      telegram_update_id INTEGER PRIMARY KEY,
      reply_to_message_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE dsh_message_links (
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      event_fingerprint TEXT NOT NULL UNIQUE,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (telegram_chat_id, telegram_message_id)
    );
  `);
  migrateAntigravityBridgeTables(db);
  return { db, close: () => db.close() } as unknown as StateDb;
}

describe("AntigravityNewSessionManager, AntigravityReplyRouter & 3-way routeProviderReply", () => {
  test("creates managed session idempotently with saved (modelId, reasoningEffort) and rejects payload mismatch", async () => {
    const state = createFakeStateDb();
    try {
      const store = new AntigravityStore(state.db);
      const tgStore = new AntigravityTelegramStore(state.db);
      store.upsertProject({
        id: "sea-bridge",
        name: "SeaBridge",
        rootPath: "/opt/app/aitools/sea-bridge",
        policyVersion: "v1",
        updatedAt: 1_000,
      });

      const catalog = new AntigravityModelCatalog({
        cliPath: "/bin/echo",
        runner: async () => modelsFixture,
      });

      const createCalls: Array<{
        operationId: string;
        projectId: string;
        prompt: string;
        modelId?: string | null;
        reasoningEffort?: string | null;
        onSessionKnown?: (sessionId: string) => void;
      }> = [];

      const manager = new AntigravityNewSessionManager({
        store,
        tgStore,
        modelCatalog: catalog,
        sessionManager: {
          create: async (req) => {
            createCalls.push(req);
            return {
              state: "queued",
              sessionId: "agy-sess-100",
              turnId: "exec-100",
            };
          },
        },
      });

      expect((await manager.findProject("1"))?.id).toBe("sea-bridge");
      expect((await manager.findProject("SeaBridge"))?.id).toBe("sea-bridge");

      manager.setDefaultModel("chat-1", { modelId: "gemini-4-argon", reasoningEffort: "high" });

      const out1 = await manager.create(701, "chat-1", "sea-bridge", "Implement feature X");
      expect(out1).toEqual({
        status: "accepted",
        sessionId: "agy-sess-100",
        turnId: "exec-100",
        project: {
          id: "sea-bridge",
          name: "SeaBridge",
          rootPath: "/opt/app/aitools/sea-bridge",
          policyVersion: "v1",
          updatedAt: 1_000,
        },
        model: { modelId: "gemini-4-argon", reasoningEffort: "high" },
      });
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toEqual({
        operationId: "tg-agy-new-701",
        projectId: "sea-bridge",
        prompt: "Implement feature X",
        modelId: "gemini-4-argon",
        reasoningEffort: "high",
        onSessionKnown: expect.any(Function),
      });

      expect(manager.acknowledge(701, "chat-1", 5001, "agy-sess-100")).toBe(true);

      // Duplicate updateId with identical payload returns duplicate without re-running create
      const out2 = await manager.create(701, "chat-1", "sea-bridge", "Implement feature X");
      expect(out2.status).toBe("duplicate");
      expect(createCalls).toHaveLength(1);

      // Duplicate updateId with different prompt returns failed (duplicate_payload_mismatch)
      const out3 = await manager.create(701, "chat-1", "sea-bridge", "Different prompt");
      expect(out3).toEqual({ status: "failed", errorCode: "duplicate_payload_mismatch" });
    } finally {
      state.close();
    }
  });

  test("routes 3-way replies across codex, dsh, and antigravity, blocks desktop read-only replies, and detects provider conflicts", async () => {
    const state = createFakeStateDb();
    try {
      const codexStore = new DesktopMessageStore(state);
      const dshStore = new DshBridgeStore(state);
      const agyTgStore = new AntigravityTelegramStore(state.db);
      const fakeChat = { id: "chat-1" as unknown as number, type: "private" };

      let lastSent: any = null;
      let nextSendResult: { state: "queued" | "failed" | "delivery_unknown"; sessionId: string; errorCode?: string } = {
        state: "queued",
        sessionId: "agy-sess-1",
      };

      const agyRouter = new AntigravityReplyRouter({
        tgStore: agyTgStore,
        externalSessionsEnabled: false,
        sessionManager: {
          send: async (id, opId, prompt) => {
            lastSent = { id, opId, prompt };
            return nextSendResult;
          },
        },
      });

      // 1. Link managed Antigravity notification at message_id = 300
      agyTgStore.linkMessage({
        chatId: "chat-1",
        messageId: 300,
        sessionId: "agy-sess-1",
        sessionOrigin: "sea_bridge",
        eventKind: "completed",
        eventFingerprint: "fp-300",
      });

      // Unquoted message routes to latest notification (message 300 -> antigravity)
      const route1 = await routeProviderReply(
        801,
        { message_id: 301, chat: fakeChat, text: "Follow up on agy" },
        codexStore,
        dshStore,
        { queue: async () => ({ status: "delivered", exitCode: 0 }) },
        undefined,
        agyTgStore,
        agyRouter
      );
      expect(route1).toEqual({
        provider: "antigravity",
        result: { status: "delivered", sessionId: "agy-sess-1" },
      });
      expect(lastSent).toEqual({
        id: "agy-sess-1",
        opId: "tg-agy-reply-801",
        prompt: "Follow up on agy",
      });

      // Duplicate updateId returns duplicate
      const routeDup = await routeProviderReply(
        801,
        { message_id: 301, chat: fakeChat, text: "Follow up on agy" },
        codexStore,
        dshStore,
        { queue: async () => ({ status: "delivered", exitCode: 0 }) },
        undefined,
        agyTgStore,
        agyRouter
      );
      expect(routeDup).toEqual({
        provider: "antigravity",
        result: { status: "duplicate", sessionId: "agy-sess-1" },
      });

      // 2. Session busy maps to session_busy
      nextSendResult = { state: "failed", sessionId: "agy-sess-1", errorCode: "session_busy" };
      const routeBusy = await routeProviderReply(
        802,
        {
          message_id: 302,
          chat: fakeChat,
          reply_to_message: { message_id: 300, chat: fakeChat },
          text: "While busy",
        },
        codexStore,
        dshStore,
        { queue: async () => ({ status: "delivered", exitCode: 0 }) },
        undefined,
        agyTgStore,
        agyRouter
      );
      expect(routeBusy).toEqual({
        provider: "antigravity",
        result: { status: "session_busy", sessionId: "agy-sess-1" },
      });

      // 3. Desktop read-only notification at message_id = 400 returns antigravity_desktop_read_only
      agyTgStore.linkMessage({
        chatId: "chat-1",
        messageId: 400,
        sessionId: "desk-sess-9",
        sessionOrigin: "desktop",
        eventKind: "completed",
        eventFingerprint: "fp-400",
      });

      const routeDesktop = await routeProviderReply(
        803,
        {
          message_id: 401,
          chat: fakeChat,
          reply_to_message: { message_id: 400, chat: fakeChat },
          text: "Try replying to desktop session",
        },
        codexStore,
        dshStore,
        { queue: async () => ({ status: "delivered", exitCode: 0 }) },
        undefined,
        agyTgStore,
        agyRouter
      );
      expect(routeDesktop).toEqual({ status: "antigravity_desktop_read_only" });

      // 4. Provider conflict when both codex and antigravity map message_id = 500
      codexStore.link({
        chatId: "chat-1",
        messageId: 500,
        threadId: "codex-t-1",
        turnId: "turn-1",
        eventKind: "completed",
        eventFingerprint: "fp-codex-500",
      });
      agyTgStore.linkMessage({
        chatId: "chat-1",
        messageId: 500,
        sessionId: "agy-sess-1",
        sessionOrigin: "sea_bridge",
        eventKind: "completed",
        eventFingerprint: "fp-agy-500",
      });

      const routeConflict = await routeProviderReply(
        804,
        {
          message_id: 501,
          chat: fakeChat,
          reply_to_message: { message_id: 500, chat: fakeChat },
          text: "Ambiguous target",
        },
        codexStore,
        dshStore,
        { queue: async () => ({ status: "delivered", exitCode: 0 }) },
        undefined,
        agyTgStore,
        agyRouter
      );
      expect(routeConflict).toEqual({ status: "provider_conflict" });
    } finally {
      state.close();
    }
  });
});

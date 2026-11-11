import type { Database } from "bun:sqlite";
import path from "node:path";
import type { WebStore } from "../web/store.ts";
import type { WebSource } from "../web/sources/types.ts";
import { AntigravityWebSource } from "../web/sources/antigravity.ts";
import { AntigravityApprovalBridge } from "./approval-bridge.ts";
import { AntigravityCapabilityGate } from "./capabilities.ts";
import { loadAntigravityConfig, type AntigravityConfig } from "./config.ts";
import { AntigravityDesktopAppController } from "./desktop-app-controller.ts";
import { AntigravityDesktopObserver } from "./desktop-observer.ts";
import { AntigravityDesktopReader } from "./desktop-reader.ts";
import { AntigravityModelCatalog } from "./model-catalog.ts";
import { AntigravityNewSessionManager } from "./new-session-manager.ts";
import { AntigravityReplyRouter } from "./reply-router.ts";
import { AntigravitySessionManager } from "./session-manager.ts";
import { AntigravityStore } from "./store.ts";
import { AntigravityTelegramHandler, type TelegramHandlerClient } from "./telegram-handler.ts";
import { AntigravityTelegramStore } from "./telegram-store.ts";

export interface AntigravityRuntimeHandle {
  readonly config: AntigravityConfig;
  createWebSource(webStore: WebStore): WebSource | undefined;
  createTelegramComponents(
    telegram: TelegramHandlerClient,
    chatId: string
  ): {
    handler: AntigravityTelegramHandler;
    observer: AntigravityDesktopObserver;
  } | undefined;
  stop(): Promise<void>;
}

/** Bootstrap shared Antigravity runtime components for both Web and Telegram without bloating `src/main.ts`. */
export function createAntigravityRuntime(
  db: Database,
  env: Readonly<Record<string, string | undefined>> = process.env
): AntigravityRuntimeHandle {
  const config = loadAntigravityConfig(env);
  const store = new AntigravityStore(db);
  const tgStore = new AntigravityTelegramStore(db);
  store.recoverOnStartup(Date.now());
  tgStore.recoverInterruptedWrites(Date.now());

  if (config.allowedProjects.length > 0) {
    const now = Date.now();
    for (const proj of config.allowedProjects) {
      store.upsertProject({
        id: proj.id,
        name: proj.name,
        rootPath: proj.rootPath,
        policyVersion: "v1",
        updatedAt: now,
      });
    }
  }

  let boundWebStore: WebStore | undefined;
  let activeObserver: AntigravityDesktopObserver | null = null;
  let activeDesktopAppController: AntigravityDesktopAppController | null = null;
  const webStoreProxy = {
    transitionQueuedOperation: (
      operationId: string,
      state: "accepted" | "failed" | "delivery_unknown",
      now = Date.now(),
      errorCode?: string | null
    ) => boundWebStore?.transitionQueuedOperation(operationId, state, now, errorCode) ?? false,
  } as unknown as WebStore;

  const capabilityGate = new AntigravityCapabilityGate({
    enabled: config.enabled,
    writeEnabled: config.writeEnabled,
    desktopReadEnabled: config.desktopReadEnabled,
    externalSessionsEnabled: config.externalSessionsEnabled,
  });
  const modelCatalog = new AntigravityModelCatalog({
    cliPath: config.cliPath,
    geminiDir: config.geminiDir,
    appDataDir: config.appDataDir,
  });
  const approvalBridge = new AntigravityApprovalBridge(store, {
    timeoutMs: config.approvalTimeoutMs,
  });
  const getAllowedProjects = () => store.listProjects();
  const cliAppDataDir = path.isAbsolute(config.appDataDir)
    ? config.appDataDir
    : path.join(config.geminiDir, config.appDataDir);
  const desktopReader = new AntigravityDesktopReader({
    desktopAppDataDir: config.desktopAppDataDir,
    cliAppDataDir,
    getAllowedProjects,
  });
  if (config.allowedProjects.length === 0 && config.desktopReadEnabled) {
    const now = Date.now();
    for (const proj of desktopReader.discoverWorkspaceProjects()) {
      store.upsertProject({ id: proj.id, name: proj.name, rootPath: proj.rootPath, policyVersion: "auto-v1", updatedAt: now });
    }
  }
  activeDesktopAppController = new AntigravityDesktopAppController({
    desktopAppDataDir: config.desktopAppDataDir,
    desktopReader,
    tgStore,
  });
  const sessionManager = new AntigravitySessionManager({
    store,
    webStore: webStoreProxy,
    approvalBridge,
    capabilityGate,
    modelCatalog,
    cliPath: config.cliPath,
    geminiDir: config.geminiDir,
    appDataDir: config.appDataDir,
    desktopReader,
    desktopAppDataDir: config.desktopAppDataDir,
    approvalPolicy: config.approvalPolicy,
    externalSessionsEnabled: config.externalSessionsEnabled,
    getAllowedProjects,
    onSessionEvent: () => {
      activeObserver?.wake();
    },
    onDesktopTurnSettled: (sessionId) => {
      void activeDesktopAppController?.onDesktopTurnSettled(sessionId);
    },
  });

  return {
    config,
    createWebSource(webStore: WebStore): WebSource | undefined {
      if (!config.enabled) return undefined;
      boundWebStore = webStore;
      return new AntigravityWebSource({
        config,
        store,
        webStore,
        capabilityGate,
        modelCatalog,
        desktopReader,
        approvalBridge,
        sessionManager,
      });
    },
    createTelegramComponents(telegram: TelegramHandlerClient, chatId: string) {
      if (!config.enabled) return undefined;
      const desktopAppController = new AntigravityDesktopAppController({
        desktopAppDataDir: config.desktopAppDataDir,
        desktopReader,
        tgStore,
        telegram,
        defaultChatId: chatId,
      });
      activeDesktopAppController = desktopAppController;
      const newSessions = new AntigravityNewSessionManager({
        store,
        tgStore,
        modelCatalog,
        sessionManager,
      });
      const replyRouter = new AntigravityReplyRouter({
        tgStore,
        externalSessionsEnabled: config.externalSessionsEnabled,
        desktopAppController,
        sessionManager,
      });
      const observer = new AntigravityDesktopObserver({
        store,
        tgStore,
        approvalBridge,
        ...(config.desktopReadEnabled ? { desktopReader } : {}),
        telegram,
        chatId,
        replyEnabled: config.writeEnabled,
        externalSessionsEnabled: config.externalSessionsEnabled,
      });
      activeObserver = observer;
      const handler = new AntigravityTelegramHandler({
        config,
        store,
        tgStore,
        capabilityGate,
        modelCatalog,
        approvalBridge,
        newSessions,
        replyRouter,
        desktopAppController,
        observer,
        telegram,
      });
      return { handler, observer };
    },
    async stop(): Promise<void> {
      await activeObserver?.stop();
      activeObserver = null;
      await sessionManager.shutdown(4000);
    },
  };
}

import { loadConfig, loadWebConfig, isExecutableUsable } from "./config.ts";
import { startWebLifecycle, WebServer } from "./web/server.ts";
import { createLogger } from "./logger.ts";
import { StateDb } from "./state/db.ts";
import { ContinuationQueue } from "./state/continuation-queue.ts";
import { SessionStateStore } from "./desktop/session-state.ts";
import { TelegramClient } from "./telegram/client.ts";
import { ApprovalCoordinator } from "./desktop/approval-coordinator.ts";
import { CodexHookProvider } from "./desktop/providers/codex-hook.ts";
import { HookServer } from "./desktop/providers/hook-server.ts";
import { TelegramService } from "./telegram/service.ts";
import { DesktopSameSessionAdapter } from "./desktop/same-session-adapter.ts";
import { DesktopMessageStore } from "./state/desktop-message-store.ts";
import { CodexThreadStore } from "./desktop/codex-thread-store.ts";
import { DesktopObserver } from "./desktop/desktop-observer.ts";
import { ProcessCodexQueueClient } from "./desktop/codex-queue-client.ts";
import { ThreadHistoryStore } from "./desktop/thread-history-store.ts";
import { CodexAppServerClient } from "./desktop/codex-app-server-client.ts";
import { NewThreadManager } from "./desktop/new-thread-manager.ts";
import { NewThreadStateStore } from "./state/new-thread-state-store.ts";
import { createAppServerApprovalHandler } from "./desktop/app-server-approval-bridge.ts";
import { DshBridgeStore } from "./state/dsh-bridge-store.ts";
import { DshWebHostClient } from "./dsh/web-host-client.ts";
import { DshReadOnlyBridge } from "./dsh/read-only-bridge.ts";
import { DshSessionObserver } from "./dsh/session-observer.ts";
import { DshReplyRouter } from "./dsh/reply-router.ts";
import { DshNewSessionManager } from "./dsh/new-session-manager.ts";

function seedCapabilities(state: StateDb): void {
  const now = Date.now();
  const values: Array<[string, string, string | null, string | null]> = [
    ["DESKTOP_APPROVAL", "pending_contract", "codex_hook.permission_request", "Requires current-version fixture/PoC"],
    ["DESKTOP_CONTINUATION", "pending_poc", "codex_hook.stop", "Requires Stop -> continuation same-thread PoC"],
    ["DESKTOP_IDLE_WAKE", "discovery_required", null, "No verified provider for fully idle Desktop conversation"],
    ["DESKTOP_CONTEXT_INJECTION", "pending_poc", "codex_hook.user_prompt_submit", "Context-only; not an idle wake provider"],
    ["DESKTOP_USER_INPUT", "discovery_required", null, "No verified pending-input response provider"],
    ["DESKTOP_INTERRUPT", "discovery_required", null, "Interrupt hook observes completed interrupt; no active interrupt provider"],
    ["DESKTOP_MESSAGE_BRIDGE", "pending_poc", "state_db_rollout_jsonl+codex_queue", "Requires Desktop notification and reply delivery PoC"],
  ];

  const statement = state.db.query(`
    INSERT INTO capabilities(name,status,provider,reason,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET status=excluded.status,provider=excluded.provider,reason=excluded.reason,updated_at=excluded.updated_at
  `);
  for (const [name, status, provider, reason] of values) statement.run(name, status, provider, reason, now);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const state = new StateDb(config.dbPath);
  seedCapabilities(state);

  const queue = new ContinuationQueue(state);
  const sessions = new SessionStateStore(state);
  const telegramClient = new TelegramClient(config.telegramBotToken);
  const approvals = new ApprovalCoordinator(
    state,
    telegramClient,
    config.allowedChatId,
    config.approvalTimeoutMs,
    logger,
  );
  const desktop = new DesktopSameSessionAdapter(state, sessions, queue, config.activeSessionTtlMs);
  const messages = new DesktopMessageStore(state);
  const queueClient = new ProcessCodexQueueClient(config.codexCliPath);
  const threadStore = new CodexThreadStore(config.codexStateDbPath);
  const appServerClient = new CodexAppServerClient(config.codexCliPath, {
    inboundRequestHandler: createAppServerApprovalHandler(approvals, logger),
    codexHome: config.codexHome,
  });
  const newThreadManager = new NewThreadManager(
    appServerClient,
    new NewThreadStateStore(state),
    {
      onThreadStarted: (threadId) => {
        messages.registerCreatedThread(threadId);
      },
    },
  );

  let dshReadOnly: DshReadOnlyBridge | undefined;
  let dshStore: DshBridgeStore | undefined;
  let dshReplyRouter: DshReplyRouter | undefined;
  let dshNewSessions: DshNewSessionManager | undefined;
  let dshObserver: DshSessionObserver | null = null;
  if (config.dshReadOnlyEnabled) {
    dshStore = new DshBridgeStore(state);
    const dshHost = new DshWebHostClient({
      socketPath: config.dshSocketPath,
      tokenPath: config.dshTokenPath,
    });
    dshReadOnly = new DshReadOnlyBridge(dshHost, dshStore);

    if (config.dshWriteEnabled) {
      const recovered = dshStore.recoverInterruptedWrites();
      if (recovered.deliveries > 0 || recovered.creations > 0) {
        logger.warn("dsh_interrupted_writes_quarantined", recovered);
      }
      dshReplyRouter = new DshReplyRouter(dshHost, dshStore);
      dshNewSessions = new DshNewSessionManager(dshHost, dshStore);
    }

    if (config.dshNotificationsEnabled) {
      dshObserver = new DshSessionObserver(
        dshHost,
        dshStore,
        telegramClient,
        config.allowedChatId,
        config.dshPollIntervalMs,
        config.dshWriteEnabled,
      );
    }

    try {
      const health = await dshHost.health();
      logger.info("dsh_connected", {
        protocol: health.protocol,
        connectorVersion: health.connectorVersion,
        notificationsEnabled: config.dshNotificationsEnabled,
        writeEnabled: config.dshWriteEnabled,
      });
    } catch (error) {
      logger.warn("dsh_unavailable_at_startup", {
        error: error instanceof Error ? error.name : "unknown_error",
        notificationsEnabled: config.dshNotificationsEnabled,
        writeEnabled: config.dshWriteEnabled,
        retryByObserver: Boolean(dshObserver),
      });
    }
  }
  if (!isExecutableUsable(config.codexCliPath)) {
    const errorMsg = [
      "⚠️ [Sea-Bridge 警告] 未找到可用的 Codex CLI 可执行文件！",
      `尝试路径: ${config.codexCliPath}`,
      "请检查 ChatGPT.app 是否安装或路径权限。回复会话与 App Server 功能将受限。",
    ].join("\n");
    logger.error("codex_cli_unusable", { path: config.codexCliPath });
    try {
      await telegramClient.sendMessage(config.allowedChatId, errorMsg);
    } catch (e) {
      logger.warn("telegram_cli_warning_failed", { error: String(e) });
    }
  }

  const observer = new DesktopObserver(
    threadStore,
    new ThreadHistoryStore(config.codexThreadHistoryDbPath),
    messages,
    telegramClient,
    config.allowedChatId,
    logger,
    config.desktopPollIntervalMs,
    config.telegramSummaryMaxChars,
  );
  const hookProvider = new CodexHookProvider(
    sessions,
    queue,
    approvals,
    logger,
    { activeSessionTtlMs: config.activeSessionTtlMs },
  );
  const hookServer = new HookServer(config.hookSocketPath, hookProvider, logger);
  const telegram = new TelegramService(
    config,
    state,
    telegramClient,
    desktop,
    approvals,
    messages,
    queueClient,
    logger,
    threadStore,
    newThreadManager,
    dshReadOnly,
    dshStore,
    dshReplyRouter,
    dshNewSessions,
    dshObserver ?? undefined,
  );

  const web = await startWebLifecycle(loadWebConfig, () => new WebServer(), logger);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_started", { signal });
    await web?.stop().catch(() => logger.warn("web_stop_failed", { errorCode: "web_stop_failed" }));
    telegram.stop();
    await dshObserver?.stop().catch((error) => logger.warn("dsh_observer_stop_failed", { error: String(error) }));
    await observer.stop();
    await hookServer.stop().catch((error) => logger.warn("hook_server_stop_failed", { error: String(error) }));
    await appServerClient.close().catch((error) => logger.warn("app_server_stop_failed", { error: String(error) }));
    state.close();
    logger.info("shutdown_complete");
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await hookServer.start();
  observer.start();
  dshObserver?.start();
  logger.info("sea_bridge_started", {
    dbPath: config.dbPath,
    hookSocketPath: config.hookSocketPath,
    approvalTimeoutMs: config.approvalTimeoutMs,
    activeSessionTtlMs: config.activeSessionTtlMs,
    dshReadOnlyEnabled: config.dshReadOnlyEnabled,
    dshWriteEnabled: config.dshWriteEnabled,
    dshNotificationsEnabled: config.dshNotificationsEnabled,
  });
  await telegram.run();
  await shutdown("telegram_loop_exit");
}

main().catch((error) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "fatal", error: String(error) }));
  process.exitCode = 1;
});

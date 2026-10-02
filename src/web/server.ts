import type { Logger } from "../logger.ts";
import type { WebConfig, WebService } from "./types.ts";

/** Contain Web configuration/startup failures and clean partially started services. */
export async function startWebLifecycle(
  readConfig: () => WebConfig,
  create: (config: WebConfig) => WebService,
  logger: Logger,
): Promise<WebService | null> {
  let service: WebService | null = null;
  try {
    const config = readConfig();
    if (!config.enabled) return null;
    service = create(config);
    await service.start();
    const started = service;
    let stopping: Promise<void> | null = null;
    return {
      async start() {},
      stop() { stopping ??= started.stop(); return stopping; },
    };
  } catch {
    // Raw errors can contain configuration secrets; later diagnostics use stable codes.
    logger.warn("web_start_failed", { errorCode: "web_setup_failed" });
    try { await service?.stop(); }
    catch { logger.warn("web_cleanup_failed", { errorCode: "web_cleanup_failed" }); }
    return null;
  }
}

/** Lifecycle placeholder; no listener exists until the authenticated server is wired. */
export class WebServer implements WebService {
  async start(): Promise<void> {
    throw new Error("web_not_implemented");
  }
  async stop(): Promise<void> {}
}

import type { Logger } from "../logger.ts";
import type { WebConfig, WebService } from "./types.ts";
import { join } from "node:path";
import { classifyRequest } from "./auth.ts";

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

/** Fixed-loopback HTTP service with allowlisted static assets and injected authenticated API. */
export class WebServer implements WebService {
  private server: Bun.Server<undefined> | null = null;

  /** Require explicit configuration and handlers; no global state is consulted. */
  constructor(private readonly options?: {
    config: WebConfig; staticRoot: string;
    handler: (request: Request, peer: string) => Promise<Response>;
  }) {}

  /** Validate required assets before opening any loopback listener. */
  async start(): Promise<void> {
    if (!this.options) throw new Error("web_not_implemented");
    const { config, staticRoot, handler } = this.options;
    const assets = new Map<string, { bytes: ArrayBuffer; type: string }>();
    for (const [path, file, type] of [["/", "index.html", "text/html; charset=utf-8"], ["/app.js", "app.js", "text/javascript; charset=utf-8"], ["/app.css", "app.css", "text/css; charset=utf-8"]]) {
      if (!path || !file || !type) throw new Error("web_asset_invalid");
      const asset = Bun.file(join(staticRoot, file));
      if (!(await asset.exists()) || asset.size > 1024 * 1024) throw new Error("web_asset_missing");
      assets.set(path, { bytes: await asset.arrayBuffer(), type });
    }
    this.server = Bun.serve({ hostname: "127.0.0.1", port: config.port, maxRequestBodySize: 65536, idleTimeout: 30,
      fetch: async (request, server) => {
        const peer = server.requestIP(request)?.address ?? "unknown";
        const url = new URL(request.url);
        const asset = assets.get(url.pathname);
        if (asset && request.method === "GET") {
          if (!classifyRequest(request, { port: config.port, remoteOrigin: config.remoteOrigin, peer }, false)) return new Response("Forbidden", { status: 403 });
          return new Response(asset.bytes, { headers: {
            "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
          } });
        }
        return handler(request, peer);
      },
      error: () => new Response("Service unavailable", { status: 503 }),
    });
  }

  /** Stop existing connections before the shared database is closed. */
  async stop(): Promise<void> { const server = this.server; this.server = null; await server?.stop(true); }
}

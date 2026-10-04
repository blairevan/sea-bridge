import type { Database } from "bun:sqlite";
import { migrateWeb } from "./migrations.ts";
import { WebStore } from "./store.ts";
import { loadOperationPepper } from "./crypto.ts";
import { WebAuth } from "./auth.ts";
import { WebControlServer } from "./control-server.ts";
import { WebEvents } from "./events.ts";
import { WebRedaction } from "./redaction.ts";
import { createWebHandler } from "./http.ts";
import { WebServer, resolveWebStaticRoot } from "./server.ts";
import type { WebConfig, WebService } from "./types.ts";
import type { WebSource } from "./sources/types.ts";
import type { TelegramStatus } from "./status.ts";

/** Web runtime resources composed after the existing bridge's database is healthy. */
export class WebRuntime implements WebService {
  private server: WebServer | null = null;
  private control: WebControlServer | null = null;
  private events: WebEvents | null = null;
  private cleanup: ReturnType<typeof setInterval> | null = null;

  /** Accept shared resources without taking ownership of the core database or clients. */
  constructor(private readonly options: {
    config: WebConfig; db: Database; secrets: readonly string[];
    sourceFactory: (store: WebStore) => Partial<Record<"codex" | "dsh", WebSource>>;
    telegramStatus: () => TelegramStatus; staticRoot?: string;
  }) {}

  /** Migrate and quarantine incomplete dispatches before exposing any browser write route. */
  async start(): Promise<void> {
    const { config, db } = this.options;
    migrateWeb(db); const store = new WebStore(db);
    const pepper = loadOperationPepper(config.operationPepperPath, store.operationsExist());
    store.recoverOperations(Date.now()); store.cleanup(Date.now());
    const auth = new WebAuth(store); this.events = new WebEvents(store);
    const redaction = new WebRedaction(this.options.secrets);
    const sources = this.options.sourceFactory(store);
    const handler = createWebHandler({ store, auth, events: this.events, redaction, pepper, sources, port: config.port,
      remoteOrigin: config.remoteOrigin, telegramStatus: this.options.telegramStatus });
    this.control = new WebControlServer(config.controlSocketPath, auth, () => this.events?.revokeAll()); await this.control.start();
    this.server = new WebServer({ config, handler, staticRoot: this.options.staticRoot ?? await resolveWebStaticRoot() }); await this.server.start();
    this.cleanup = setInterval(() => { try { store.cleanup(Date.now()); } catch { /* Retention failure cannot stop the existing bridge. */ } }, 60000);
    this.cleanup.unref();
    db.query("INSERT INTO web_logs(level,event,fields_json,created_at) VALUES('info','web_started','{}',?)").run(Date.now());
  }

  /** Stop only Web resources, before the owner closes shared state and source clients. */
  async stop(): Promise<void> {
    if (this.cleanup) clearInterval(this.cleanup); this.cleanup = null;
    const server = this.server; this.server = null; await server?.stop();
    this.events?.close(); this.events = null;
    const control = this.control; this.control = null; await control?.stop();
  }
}

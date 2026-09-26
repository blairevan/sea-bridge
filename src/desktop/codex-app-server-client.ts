import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  resolveDesktopPermissions,
  type ResolvedDesktopPermissions,
} from "./desktop-permissions.ts";

export interface ProjectItem {
  index: number;
  id: string;
  name: string;
  roots: string[];
  primaryRoot: string;
  position: number;
}

export interface ModelOption {
  id: string;
  displayName: string;
}

export interface StartedThread {
  threadId: string;
  turnId: string;
  projectId: string;
  cwd: string;
  model: string | null;
}

type ProcessSpawner = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

export type AppServerRequestId = number | string;

export interface AppServerInboundRequest {
  id: AppServerRequestId;
  method: string;
  params: Record<string, unknown>;
}

export type AppServerInboundRequestHandler =
  (request: AppServerInboundRequest) => Promise<Record<string, unknown> | null>;

export interface CodexAppServerClientOptions {
  requestTimeoutMs?: number;
  turnLifetimeTimeoutMs?: number | null;
  spawner?: ProcessSpawner;
  inboundRequestHandler?: AppServerInboundRequestHandler;
  codexHome?: string;
  permissionsResolver?: () => ResolvedDesktopPermissions;
}

interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

interface RpcMessage {
  id?: AppServerRequestId;
  method?: string;
  params?: any;
  result?: any;
  error?: RpcErrorShape;
}

interface ProjectWireItem {
  id?: string;
  projectId?: string;
  name?: string;
  roots?: Array<{ path?: string } | string>;
  path?: string;
  position?: number;
}

interface ProjectListResponse {
  data?: ProjectWireItem[];
  nextCursor?: string | null;
}

interface ModelListResponse {
  data?: Array<{ id?: string; model?: string; displayName?: string; hidden?: boolean }>;
  nextCursor?: string | null;
}

interface ThreadUnsubscribeResponse {
  status?: "notLoaded" | "notSubscribed" | "unsubscribed";
}

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationWaiter {
  predicate: (message: RpcMessage) => boolean;
  resolve: (message: RpcMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

function defaultSpawner(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

class AppServerSession {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Set<NotificationWaiter>();
  private readonly recentNotifications: RpcMessage[] = [];
  private buffer = "";
  private stderr = "";
  private nextRequestId = 1;
  private closed = false;
  private closing = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
    private readonly inboundRequestHandler?: AppServerInboundRequestHandler,
  ) {
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");
    child.stdout.on("data", (chunk: Buffer | string) => this.onData(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (this.stderr.length < 4096) {
        this.stderr += chunk.toString().slice(0, 4096 - this.stderr.length);
      }
    });
    child.once("error", (error) => this.fail(new Error(`app_server_process_error: ${String(error)}`)));
    child.once("close", (code, signal) => {
      this.closed = true;
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      if (!this.closing) {
        this.fail(new Error(`app_server_closed(code=${String(code)},signal=${String(signal)})${suffix}`));
      } else {
        this.rejectWaiters(new Error("app_server_session_closed"));
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "sea-bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("app_server_session_closed"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app_server_rpc_timeout:${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  waitForNotification(
    predicate: (message: RpcMessage) => boolean,
    timeoutMs: number | null = null,
  ): Promise<RpcMessage> {
    const buffered = this.recentNotifications.find(predicate);
    if (buffered) return Promise.resolve(buffered);
    if (this.closed) return Promise.reject(new Error("app_server_session_closed"));

    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve: (message) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          resolve(message);
        },
        reject: (error) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          reject(error);
        },
        timer: null,
      };
      if (timeoutMs != null && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error("app_server_notification_timeout"));
        }, timeoutMs);
      }
      this.notificationWaiters.add(waiter);
    });
  }

  async closeGracefully(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      this.child.stdin.end();
    } catch {
      // Continue with forced shutdown below.
    }

    if (await this.waitForClose(250)) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Ignore and escalate.
    }
    if (await this.waitForClose(250)) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Process may already be gone.
    }
    await this.waitForClose(100);
  }

  private waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.child.once("close", onClose);
      timer = setTimeout(() => {
        this.child.removeListener("close", onClose);
        resolve(this.closed);
      }, timeoutMs);
    });
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.fail(new Error("app_server_invalid_json"));
        return;
      }

      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          void this.handleInboundRequest(message);
          continue;
        }
        this.recentNotifications.push(message);
        if (this.recentNotifications.length > 100) this.recentNotifications.shift();
        for (const waiter of [...this.notificationWaiters]) {
          if (waiter.predicate(message)) waiter.resolve(message);
        }
        continue;
      }

      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new CodexAppServerRpcError(
            pending.method,
            message.error.code,
            message.error.message ?? "app_server_rpc_error",
            message.error.data,
          ));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  private async handleInboundRequest(message: RpcMessage): Promise<void> {
    const id = message.id;
    const method = message.method;
    if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") return;

    try {
      const response = this.inboundRequestHandler
        ? await this.inboundRequestHandler({
            id,
            method,
            params: (message.params ?? {}) as Record<string, unknown>,
          })
        : null;

      if (response != null) {
        this.write({ id, result: response });
        return;
      }

      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        this.write({ id, result: { decision: "decline" } });
        return;
      }
      if (method === "item/permissions/requestApproval") {
        this.write({ id, result: { permissions: {}, scope: "turn" } });
        return;
      }
      if (method === "mcpServer/elicitation/request") {
        this.write({ id, result: { action: "decline", content: null, meta: null } });
        return;
      }

      this.write({
        id,
        error: { code: -32601, message: `Sea-Bridge does not handle app-server request: ${method}` },
      });
    } catch (error) {
      this.write({
        id,
        error: { code: -32000, message: `Sea-Bridge inbound request failed: ${String(error)}` },
      });
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectWaiters(error);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of [...this.notificationWaiters]) waiter.reject(error);
    this.notificationWaiters.clear();
  }
}

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly turnLifetimeTimeoutMs: number | null;
  private readonly spawner: ProcessSpawner;
  private readonly inboundRequestHandler: AppServerInboundRequestHandler | undefined;
  private readonly sessions = new Set<AppServerSession>();
  private readonly permissionsResolver: () => ResolvedDesktopPermissions;

  constructor(
    private readonly codexCliPath: string,
    options: CodexAppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.turnLifetimeTimeoutMs = options.turnLifetimeTimeoutMs ?? null;
    this.spawner = options.spawner ?? defaultSpawner;
    this.inboundRequestHandler = options.inboundRequestHandler;
    this.permissionsResolver = options.permissionsResolver ?? (() => resolveDesktopPermissions(options.codexHome));
  }

  async listProjects(): Promise<ProjectItem[]> {
    const session = await this.openSession();
    try {
      const projects: ProjectWireItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const response: ProjectListResponse = await session.request<ProjectListResponse>("project/list", {
          cursor,
          limit: 100,
          sortKey: "position",
          sortDirection: "asc",
        });
        if (Array.isArray(response?.data)) projects.push(...response.data);
        cursor = response?.nextCursor ?? null;
        if (!cursor) break;
        if (page === 19) throw new Error("app_server_project_list_page_limit");
      }

      const normalized = projects
        .map((project) => {
          const roots = (project.roots ?? [])
            .map((root) => typeof root === "string" ? root : root?.path)
            .filter((root): root is string => typeof root === "string" && root.length > 0);
          if (roots.length === 0 && typeof project.path === "string" && project.path.length > 0) {
            roots.push(project.path);
          }
          const id = project.id ?? project.projectId ?? "";
          const name = project.name ?? roots[0]?.split("/").filter(Boolean).at(-1) ?? id;
          return {
            id,
            name,
            roots,
            primaryRoot: roots[0] ?? "",
            position: Number(project.position ?? Number.MAX_SAFE_INTEGER),
          };
        })
        .filter((project) => Boolean(project.id && project.name && project.primaryRoot))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

      return normalized.map((project, index) => ({ index: index + 1, ...project }));
    } finally {
      await this.releaseSession(session);
    }
  }

  async listModels(): Promise<ModelOption[]> {
    const session = await this.openSession();
    try {
      const models: Array<{ id?: string; model?: string; displayName?: string; hidden?: boolean }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const response: ModelListResponse = await session.request<ModelListResponse>(
          "model/list",
          { cursor, limit: 100, includeHidden: false },
        );
        if (Array.isArray(response?.data)) models.push(...response.data);
        cursor = response?.nextCursor ?? null;
        if (!cursor) break;
        if (page === 19) throw new Error("app_server_model_list_page_limit");
      }

      const seen = new Set<string>();
      const result: ModelOption[] = [];
      for (const model of models) {
        if (model.hidden) continue;
        const id = model.id ?? model.model;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push({ id, displayName: model.displayName || id });
      }
      return result;
    } finally {
      await this.releaseSession(session);
    }
  }

  async startThreadAndTurn(params: {
    projectId: string;
    cwd: string;
    model?: string;
    prompt: string;
    permissions?: ResolvedDesktopPermissions;
    onThreadStarted?: (threadId: string) => void;
  }): Promise<StartedThread> {
    const session = await this.openSession();
    let handedToBackground = false;
    try {
      const permissions = params.permissions ?? this.permissionsResolver();
      const threadParams: Record<string, unknown> = {
        projectId: params.projectId,
        cwd: params.cwd,
        sandbox: permissions.threadStart.sandbox,
        approvalPolicy: permissions.threadStart.approvalPolicy,
        approvalsReviewer: permissions.threadStart.approvalsReviewer,
      };
      if (params.model) threadParams.model = params.model;

      const threadResponse = await session.request<{
        thread?: { id?: string };
        model?: string;
      }>("thread/start", threadParams);
      const threadId = threadResponse?.thread?.id;
      if (!threadId) throw new Error("app_server_thread_start_missing_id");
      params.onThreadStarted?.(threadId);

      const turnPermissions = permissions.turnStart(params.cwd);
      const turnResponse = await session.request<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        input: [{
          type: "text",
          text: `[Telegram init]\n${params.prompt}`,
          textElements: [],
        }],
        approvalPolicy: turnPermissions.approvalPolicy,
        approvalsReviewer: turnPermissions.approvalsReviewer,
        sandboxPolicy: turnPermissions.sandboxPolicy,
      });
      const turnId = turnResponse?.turn?.id;
      if (!turnId) throw new Error("app_server_turn_start_missing_id");

      handedToBackground = true;
      void session.waitForNotification(
        (message) => message.method === "turn/completed"
          && message.params?.threadId === threadId
          && message.params?.turn?.id === turnId,
        this.turnLifetimeTimeoutMs,
      ).then(async () => {
        try {
          await session.request<ThreadUnsubscribeResponse>("thread/unsubscribe", { threadId });
        } catch {
          // Closing the app-server process below is still the final ownership release boundary.
        }
      }).catch(() => undefined).finally(() => void this.releaseSession(session));

      return {
        threadId,
        turnId,
        projectId: params.projectId,
        cwd: params.cwd,
        model: threadResponse?.model ?? params.model ?? null,
      };
    } finally {
      if (!handedToBackground) await this.releaseSession(session);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => this.releaseSession(session)));
  }

  private async openSession(): Promise<AppServerSession> {
    const child = this.spawner(this.codexCliPath, ["app-server", "--stdio"]);
    const session = new AppServerSession(child, this.requestTimeoutMs, this.inboundRequestHandler);
    this.sessions.add(session);
    try {
      await session.initialize();
      return session;
    } catch (error) {
      await this.releaseSession(session);
      throw error;
    }
  }

  private async releaseSession(session: AppServerSession): Promise<void> {
    if (!this.sessions.delete(session)) return;
    await session.closeGracefully();
  }
}

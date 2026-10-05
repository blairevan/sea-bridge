import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "../logger.ts";
import { classifyCreationClient, type CreationClient } from "./codex-provenance.ts";
import {
  AppServerSession,
  CodexAppServerRpcError,
  spawnAppServerProcess,
  type ModelOption,
  type ProcessSpawner,
  type ProjectItem,
} from "./codex-app-server-client.ts";

export type CodexReadServiceState =
  | "starting"
  | "ready"
  | "degraded"
  | "restarting"
  | "protocol_incompatible"
  | "stopped";

export interface CodexReadThread {
  id: string;
  title: string;
  rolloutPath: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  recencyAtMs: number | null;
  source: unknown;
  originator: string | null;
  parentThreadId: string | null;
  threadSource: unknown;
  creationClient: CreationClient;
}

export type CodexTurnStatus = "completed" | "failed" | "interrupted" | "inProgress";

export interface CodexReadTurn {
  id: string;
  status: CodexTurnStatus;
  startedAtMs: number | null;
  completedAtMs: number | null;
  itemsView: "notLoaded" | "summary" | "full" | string;
}

export interface CodexThreadPage {
  data: CodexReadThread[];
  nextCursor: string | null;
}

export interface CodexTurnPage {
  data: CodexReadTurn[];
  nextCursor: string | null;
}

export interface CodexItemsPage {
  data: unknown[];
  nextCursor: string | null;
}

interface ThreadWire {
  id?: unknown;
  name?: unknown;
  preview?: unknown;
  path?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  recencyAt?: unknown;
  source?: unknown;
  originator?: unknown;
  parentThreadId?: unknown;
  threadSource?: unknown;
}

interface TurnWire {
  id?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  itemsView?: unknown;
}

interface PageResponse<T> {
  data?: T[];
  nextCursor?: string | null;
}

interface ThreadReadResponse {
  thread?: ThreadWire;
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

export interface CodexReadServiceOptions {
  requestTimeoutMs?: number;
  spawner?: ProcessSpawner;
  maxPages?: number;
  pageSize?: number;
  logger?: Logger;
  restartDelaysMs?: number[];
  maxConsecutiveTimeouts?: number;
  stableResetMs?: number;
  random?: () => number;
  maxStdoutBufferChars?: number;
  maxJsonLineChars?: number;
}

const READ_METHODS = new Set([
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "project/list",
  "model/list",
]);

const ORDINARY_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"] as const;

function milliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}

function boundedString(value: unknown, max = 10_000): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function isHiddenThread(value: ThreadWire): boolean {
  const parentThreadId = boundedString(value.parentThreadId, 200);
  const source = value.source;
  return Boolean(parentThreadId || value.threadSource === "subagent" || (source && typeof source === "object" && "subAgent" in source));
}

function normalizeThread(value: ThreadWire): CodexReadThread | null {
  const id = boundedString(value.id, 200);
  if (!id) return null;
  const parentThreadId = boundedString(value.parentThreadId, 200);
  const threadSource = value.threadSource;
  const source = value.source;
  const name = boundedString(value.name, 2_000)?.trim();
  const preview = boundedString(value.preview, 2_000)?.trim();
  const title = name || preview || `未命名会话 · ${id.slice(-8)}`;
  const originator = boundedString(value.originator, 200);
  const sourceForClassification = typeof source === "string" ? source : null;
  return {
    id,
    title,
    rolloutPath: boundedString(value.path, 32_000),
    createdAtMs: milliseconds(value.createdAt) ?? 0,
    updatedAtMs: milliseconds(value.updatedAt) ?? 0,
    recencyAtMs: milliseconds(value.recencyAt),
    source,
    originator,
    parentThreadId,
    threadSource,
    creationClient: classifyCreationClient(sourceForClassification, originator),
  };
}

function normalizeTurn(value: TurnWire): CodexReadTurn | null {
  const id = boundedString(value.id, 200);
  if (!id) return null;
  const rawStatus = boundedString(value.status, 40);
  if (!rawStatus || !["completed", "failed", "interrupted", "inProgress"].includes(rawStatus)) return null;
  return {
    id,
    status: rawStatus as CodexTurnStatus,
    startedAtMs: milliseconds(value.startedAt),
    completedAtMs: milliseconds(value.completedAt),
    itemsView: boundedString(value.itemsView, 40) ?? "notLoaded",
  };
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (/^[A-Za-z0-9_]+/.exec(raw)?.[0] ?? (error instanceof Error ? error.name : "unknown_error")).slice(0, 120);
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof CodexAppServerRpcError) return false;
  return /app_server_(?:closed|process_error|session_closed|invalid_json|stdout_buffer_limit|message_size_limit)/.test(error.message);
}

function isProtocolUnsupported(error: unknown): boolean {
  return error instanceof CodexAppServerRpcError && (
    error.code === -32601
    || error.code === -32602
    || /method.*not found|invalid params/i.test(error.message)
  );
}

/** Long-lived, query-only Codex app-server client. */
export class CodexReadService {
  private readonly requestTimeoutMs: number;
  private readonly spawner: ProcessSpawner;
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly maxStdoutBufferChars: number | undefined;
  private readonly maxJsonLineChars: number | undefined;
  private readonly restartDelaysMs: number[];
  private session: AppServerSession | null = null;
  private opening: Promise<AppServerSession> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private nextRestartAt = 0;
  private consecutiveTimeouts = 0;
  private readySince = 0;
  private stopped = false;
  private _state: CodexReadServiceState = "starting";
  private _generation = 0;

  constructor(
    private readonly codexCliPath: string,
    private readonly codexHome: string,
    private readonly options: CodexReadServiceOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.spawner = options.spawner ?? spawnAppServerProcess;
    this.maxPages = options.maxPages ?? 100;
    this.pageSize = options.pageSize ?? 25;
    this.maxStdoutBufferChars = options.maxStdoutBufferChars;
    this.maxJsonLineChars = options.maxJsonLineChars;
    this.restartDelaysMs = options.restartDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
  }

  get state(): CodexReadServiceState {
    return this._state;
  }

  get generation(): number {
    return this._generation;
  }

  async start(): Promise<void> {
    await this.ensureSession();
    await this.listThreadPage(null);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this._state = "stopped";
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.nextRestartAt = 0;
    const session = this.session;
    const opening = this.opening;
    this.session = null;
    if (session) await session.closeGracefully().catch(() => undefined);
    if (opening) {
      await opening.then((pending) => pending.closeGracefully()).catch(() => undefined);
    }
    this.opening = null;
  }

  async listThreadPage(cursor: string | null = null): Promise<CodexThreadPage> {
    const response = await this.query<PageResponse<ThreadWire>>("thread/list", {
      cursor,
      limit: this.pageSize,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: [...ORDINARY_SOURCE_KINDS],
      archived: false,
      useStateDbOnly: true,
    });
    if (!response || !Array.isArray(response.data)) this.protocolFailure("codex_thread_list_invalid_response");
    const normalized: CodexReadThread[] = [];
    for (const value of response.data) {
      if (!value || typeof value !== "object") this.protocolFailure("codex_thread_list_invalid_thread");
      if (isHiddenThread(value)) continue;
      const thread = normalizeThread(value);
      if (!thread) this.protocolFailure("codex_thread_list_invalid_thread");
      normalized.push(thread);
    }
    if (response.nextCursor != null && typeof response.nextCursor !== "string") this.protocolFailure("codex_thread_list_invalid_cursor");
    return {
      data: normalized,
      nextCursor: response.nextCursor ?? null,
    };
  }

  async listThreads(): Promise<CodexReadThread[]> {
    const result: CodexReadThread[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const current = await this.listThreadPage(cursor);
      for (const thread of current.data) {
        if (seen.has(thread.id)) continue;
        seen.add(thread.id);
        result.push(thread);
      }
      if (!current.nextCursor) return result;
      if (cursors.has(current.nextCursor)) throw new Error("codex_thread_list_cursor_loop");
      cursors.add(current.nextCursor);
      cursor = current.nextCursor;
    }
    throw new Error("codex_thread_list_page_limit");
  }

  async getThread(threadId: string): Promise<CodexReadThread | null> {
    try {
      const response = await this.query<ThreadReadResponse>("thread/read", { threadId, includeTurns: false });
      if (!response?.thread) return null;
      if (isHiddenThread(response.thread)) return null;
      const thread = normalizeThread(response.thread);
      if (!thread) this.protocolFailure("codex_thread_read_invalid_thread");
      return thread;
    } catch (error) {
      if (error instanceof CodexAppServerRpcError && /not found/i.test(error.message)) return null;
      throw error;
    }
  }

  async listTurnPage(
    threadId: string,
    cursor: string | null = null,
    sortDirection: "asc" | "desc" = "desc",
  ): Promise<CodexTurnPage> {
    const response = await this.query<PageResponse<TurnWire>>("thread/turns/list", {
      threadId,
      cursor,
      limit: this.pageSize,
      sortDirection,
      itemsView: "summary",
    });
    if (!response || !Array.isArray(response.data)) this.protocolFailure("codex_turn_list_invalid_response");
    const normalized = response.data.map(normalizeTurn);
    if (normalized.some((item) => item === null)) this.protocolFailure("codex_turn_list_invalid_turn");
    if (response.nextCursor != null && typeof response.nextCursor !== "string") this.protocolFailure("codex_turn_list_invalid_cursor");
    return {
      data: normalized as CodexReadTurn[],
      nextCursor: response.nextCursor ?? null,
    };
  }

  async listTurns(threadId: string, sortDirection: "asc" | "desc" = "desc"): Promise<CodexReadTurn[]> {
    const result: CodexReadTurn[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const current = await this.listTurnPage(threadId, cursor, sortDirection);
      for (const turn of current.data) {
        if (seen.has(turn.id)) continue;
        seen.add(turn.id);
        result.push(turn);
      }
      if (!current.nextCursor) return result;
      if (cursors.has(current.nextCursor)) throw new Error("codex_turn_list_cursor_loop");
      cursors.add(current.nextCursor);
      cursor = current.nextCursor;
    }
    throw new Error("codex_turn_list_page_limit");
  }

  async listItemsPage(threadId: string, turnId: string, cursor: string | null = null): Promise<CodexItemsPage> {
    const response = await this.query<PageResponse<unknown>>("thread/items/list", {
      threadId,
      turnId,
      cursor,
      limit: this.pageSize,
      sortDirection: "asc",
    });
    if (!response || !Array.isArray(response.data)) this.protocolFailure("codex_item_list_invalid_response");
    if (response.nextCursor != null && typeof response.nextCursor !== "string") this.protocolFailure("codex_item_list_invalid_cursor");
    return {
      data: response.data,
      nextCursor: response.nextCursor ?? null,
    };
  }

  async listItems(threadId: string, turnId: string): Promise<unknown[]> {
    const result: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const current = await this.listItemsPage(threadId, turnId, cursor);
      result.push(...current.data);
      if (!current.nextCursor) return result;
      if (cursors.has(current.nextCursor)) throw new Error("codex_item_list_cursor_loop");
      cursors.add(current.nextCursor);
      cursor = current.nextCursor;
    }
    throw new Error("codex_item_list_page_limit");
  }

  async finalText(threadId: string, turnId: string): Promise<string | null> {
    const entries = await this.listItems(threadId, turnId);
    let finalAnswer: string | null = null;
    let legacyCandidate: string | null = null;
    let sawPhasedAgentMessage = false;
    for (const entry of entries) {
      const item = entry && typeof entry === "object" && "item" in entry
        ? (entry as { item?: unknown }).item
        : entry;
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.type !== "agentMessage") continue;
      const hasPhase = Object.prototype.hasOwnProperty.call(record, "phase");
      const phase = record.phase;
      if (hasPhase) sawPhasedAgentMessage = true;
      const text = boundedString(record.text, 1_000_000)?.trim();
      if (!text) continue;
      if (phase === "final_answer") {
        finalAnswer = text;
        continue;
      }
      if (hasPhase) {
        // commentary/analysis/tool-facing phases are never terminal answer text.
        continue;
      }
      // Legacy protocols omitted phase entirely. Only use that fallback when the
      // whole agent-message stream is phase-less; mixed modern/legacy data fails closed.
      legacyCandidate = text;
    }
    return finalAnswer ?? (sawPhasedAgentMessage ? null : legacyCandidate);
  }

  async listProjects(): Promise<ProjectItem[]> {
    const projects: ProjectWireItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const response: ProjectListResponse = await this.query<ProjectListResponse>("project/list", {
        cursor,
        limit: 100,
        sortKey: "position",
        sortDirection: "asc",
      });
      if (!response || !Array.isArray(response.data)) this.protocolFailure("codex_project_list_invalid_response");
      if (response.nextCursor != null && typeof response.nextCursor !== "string") this.protocolFailure("codex_project_list_invalid_cursor");
      projects.push(...response.data);
      cursor = response.nextCursor ?? null;
      if (!cursor) break;
      if (page === 19) throw new Error("app_server_project_list_page_limit");
    }
    const normalized = projects
      .map((project) => {
        const roots = (project.roots ?? [])
          .map((root) => typeof root === "string" ? root : root?.path)
          .filter((root): root is string => typeof root === "string" && root.length > 0);
        if (roots.length === 0 && typeof project.path === "string" && project.path.length > 0) roots.push(project.path);
        const id = project.id ?? project.projectId ?? "";
        const name = project.name ?? roots[0]?.split("/").filter(Boolean).at(-1) ?? id;
        return { id, name, roots, primaryRoot: roots[0] ?? "", position: Number(project.position ?? Number.MAX_SAFE_INTEGER) };
      })
      .filter((project) => Boolean(project.id && project.name && project.primaryRoot))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    return normalized.map((project, index) => ({ index: index + 1, ...project }));
  }

  async listModels(): Promise<ModelOption[]> {
    const models: Array<{ id?: string; model?: string; displayName?: string; hidden?: boolean }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const response: ModelListResponse = await this.query<ModelListResponse>("model/list", { cursor, limit: 100, includeHidden: false });
      if (!response || !Array.isArray(response.data)) this.protocolFailure("codex_model_list_invalid_response");
      if (response.nextCursor != null && typeof response.nextCursor !== "string") this.protocolFailure("codex_model_list_invalid_cursor");
      models.push(...response.data);
      cursor = response.nextCursor ?? null;
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
  }

  private protocolFailure(message: string): never {
    this._state = "protocol_incompatible";
    this.readySince = 0;
    this.consecutiveTimeouts = 0;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.nextRestartAt = 0;
    const session = this.session;
    this.session = null;
    if (session) void session.closeGracefully().catch(() => undefined);
    throw new Error(message);
  }

  private async query<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!READ_METHODS.has(method)) throw new Error(`codex_read_method_forbidden:${method}`);
    if (this._state === "protocol_incompatible") throw new Error("codex_read_service_protocol_incompatible");
    const session = await this.ensureSession();
    try {
      const result = await session.request<T>(method, params);
      if (this.session !== session || session.isClosed()) throw new Error("codex_read_service_stale_generation");
      const now = Date.now();
      if (this._state !== "ready") this.readySince = now;
      this._state = "ready";
      this.consecutiveTimeouts = 0;
      if (this.restartAttempt > 0 && this.readySince > 0 && now - this.readySince >= (this.options.stableResetMs ?? 30_000)) {
        this.restartAttempt = 0;
      }
      this.nextRestartAt = 0;
      return result;
    } catch (error) {
      if (isProtocolUnsupported(error)) {
        this._state = "protocol_incompatible";
        throw error;
      }
      if (isTransportFailure(error)) {
        this.markTransportFailed(session, error);
      } else if (error instanceof Error && error.message.startsWith("app_server_rpc_timeout:")) {
        this.consecutiveTimeouts += 1;
        if (this.consecutiveTimeouts >= (this.options.maxConsecutiveTimeouts ?? 3)) {
          this.markTransportFailed(session, error);
        }
      }
      throw error;
    }
  }

  private async ensureSession(): Promise<AppServerSession> {
    if (this.stopped) throw new Error("codex_read_service_stopped");
    if (this.session && !this.session.isClosed()) return this.session;
    if (this.opening) return this.opening;
    if (this.restartTimer && Date.now() < this.nextRestartAt) throw new Error("codex_read_service_backoff");
    this._state = this._generation === 0 ? "starting" : "restarting";
    const opening = this.openSession();
    this.opening = opening;
    try {
      const session = await opening;
      if (this.stopped) {
        await session.closeGracefully().catch(() => undefined);
        throw new Error("codex_read_service_stopped");
      }
      this.session = session;
      this._generation += 1;
      this.options.logger?.info("codex_read_service_connected", { generation: this._generation });
      return session;
    } catch (error) {
      this._state = "degraded";
      this.options.logger?.warn("codex_read_service_start_failed", { errorCode: errorCode(error) });
      this.scheduleRestart();
      throw error;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async openSession(): Promise<AppServerSession> {
    const env = { ...process.env, CODEX_HOME: this.codexHome };
    const child: ChildProcessWithoutNullStreams = this.spawner(this.codexCliPath, ["app-server", "--stdio"], env);
    const session = new AppServerSession(child, this.requestTimeoutMs, undefined, {
      ...(this.maxStdoutBufferChars === undefined ? {} : { maxStdoutBufferChars: this.maxStdoutBufferChars }),
      ...(this.maxJsonLineChars === undefined ? {} : { maxJsonLineChars: this.maxJsonLineChars }),
    });
    try {
      await session.initialize();
      return session;
    } catch (error) {
      await session.closeGracefully().catch(() => undefined);
      throw error;
    }
  }

  private markTransportFailed(session: AppServerSession, error: unknown): void {
    if (this.session !== session) {
      void session.closeGracefully().catch(() => undefined);
      return;
    }
    this.session = null;
    this._state = "degraded";
    this.readySince = 0;
    this.consecutiveTimeouts = 0;
    this.options.logger?.warn("codex_read_service_transport_failed", {
      generation: this._generation,
      errorCode: errorCode(error),
    });
    void session.closeGracefully().catch(() => undefined);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer || this._state === "protocol_incompatible") return;
    const baseDelay = this.restartDelaysMs[Math.min(this.restartAttempt, this.restartDelaysMs.length - 1)] ?? 30_000;
    const jitter = Math.floor(baseDelay * 0.2 * (this.options.random?.() ?? Math.random()));
    const delay = baseDelay + jitter;
    this.restartAttempt += 1;
    this.nextRestartAt = Date.now() + delay;
    this.options.logger?.warn("codex_read_service_restart_scheduled", { attempt: this.restartAttempt, delayMs: delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.nextRestartAt = 0;
      if (this.stopped) return;
      void this.ensureSession().catch(() => undefined);
    }, delay);
  }
}

import { createConnection } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DshEventMetadata,
  DshFollowSnapshot,
  DshHistoryPage,
  DshHostHealth,
  DshLiveWindow,
  DshModelCatalog,
  DshModelGroup,
  DshModelSelection,
  DshProject,
  DshSessionSummary,
  DshWriteResult,
  DshCreateSessionResult,
  DshSelectModelResult,
} from "./types.ts";
import { DSH_CONNECTOR_VERSION, DshHostClientError } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 3_500;
const WRITE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export interface DshWebHostClientOptions {
  socketPath: string;
  tokenPath: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface ConnectorRequest {
  op: string;
  sessionId?: string;
  throughSeq?: number;
  beforeSeq?: number;
  requestId?: string;
  text?: string;
  workspaceId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DshHostClientError("invalid_response", "dsh connector returned an invalid object");
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DshHostClientError("invalid_response", `dsh connector returned invalid ${field}`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DshHostClientError("invalid_response", `dsh connector returned invalid ${field}`);
  }
  return value;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new DshHostClientError("invalid_response", `dsh connector returned invalid ${field}`);
  }
  return value as number;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new DshHostClientError("invalid_response", `dsh connector returned invalid ${field}`);
  }
  return value;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DshHostClientError("invalid_response", `dsh connector returned invalid ${field}`);
  }
  return value;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new DshHostClientError("invalid_request", "invalid dsh session id");
  }
}

function eventMetadata(value: unknown): DshEventMetadata {
  const row = record(value);
  const event: DshEventMetadata = {
    type: requiredString(row.type, "event.type"),
    seq: safeInteger(row.seq, "event.seq"),
    time: finiteNumber(row.time, "event.time"),
  };
  if (event.type === "turn/end") {
    const reason = row.reasonKind;
    if (reason !== undefined && reason !== "completed" && reason !== "error" &&
      reason !== "aborted" && reason !== "blocked" && reason !== "max-tokens" &&
      reason !== "interrupted" && reason !== "forked" && reason !== "stop" &&
      reason !== "tool-calls" && reason !== "unknown") {
      throw new DshHostClientError("invalid_response", "dsh connector returned invalid turn reason");
    }
    if (reason !== undefined) event.reasonKind = reason;
  }
  return event;
}

function parseProjects(payload: unknown): DshProject[] {
  const body = record(payload);
  const items = array(body.items, "projects.items");
  const totalCount = safeInteger(body.totalCount, "projects.totalCount");
  if (totalCount !== items.length) {
    throw new DshHostClientError("contract_unsupported", "dsh connector project listing is incomplete");
  }
  return items.map((value) => {
    const item = record(value);
    return {
      id: requiredString(item.id, "project.id"),
      title: requiredString(item.title, "project.title"),
      sessionCount: safeInteger(item.sessionCount, "project.sessionCount"),
    };
  });
}

function parseSessions(payload: unknown): DshSessionSummary[] {
  const body = record(payload);
  const items = array(body.items, "sessions.items");
  const totalCount = safeInteger(body.totalCount, "sessions.totalCount");
  if (totalCount !== items.length) {
    throw new DshHostClientError("contract_unsupported", "dsh connector session listing is incomplete");
  }
  return items.map((value) => {
    const item = record(value);
    return {
      sessionId: requiredString(item.sessionId, "session.sessionId"),
      updatedAt: finiteNumber(item.updatedAt, "session.updatedAt"),
      running: requiredBoolean(item.running, "session.running"),
      blank: requiredBoolean(item.blank, "session.blank"),
    };
  });
}

function parseEvents(payload: JsonRecord): DshEventMetadata[] {
  return array(payload.events, "history.events").map(eventMetadata);
}

function parseFollow(payload: unknown): DshFollowSnapshot {
  const body = record(payload);
  return {
    cursor: safeInteger(body.cursor, "follow.cursor"),
    hasMore: requiredBoolean(body.hasMore, "follow.hasMore"),
    truncated: requiredBoolean(body.truncated, "follow.truncated"),
    events: parseEvents(body),
  };
}

function parsePage(payload: unknown): DshHistoryPage {
  const body = record(payload);
  return {
    hasMore: requiredBoolean(body.hasMore, "page.hasMore"),
    truncated: requiredBoolean(body.truncated, "page.truncated"),
    events: parseEvents(body),
  };
}

function parseModels(payload: unknown): DshModelCatalog {
  const body = record(payload);
  const selected = record(body.default);
  const rawGroups = array(body.groups, "models.groups");
  const groupCount = safeInteger(body.groupCount, "models.groupCount");
  if (groupCount !== rawGroups.length) {
    throw new DshHostClientError("contract_unsupported", "dsh connector model-group listing is incomplete");
  }
  const groups: DshModelGroup[] = rawGroups.map((value) => {
    const group = record(value);
    const rawModels = array(group.models, "modelGroup.models");
    const modelCount = safeInteger(group.modelCount, "modelGroup.modelCount");
    if (modelCount !== rawModels.length) {
      throw new DshHostClientError("contract_unsupported", "dsh connector model listing is incomplete");
    }
    return {
      id: requiredString(group.id, "modelGroup.id"),
      name: requiredString(group.name, "modelGroup.name"),
      models: rawModels.map((modelValue) => {
        const model = record(modelValue);
        return {
          id: requiredString(model.id, "model.id"),
          name: requiredString(model.name, "model.name"),
        };
      }),
    };
  });
  const selection = {
    provider: requiredString(selected.provider, "models.default.provider"),
    model: requiredString(selected.model, "models.default.model"),
  } as DshModelCatalog["default"];
  if (typeof selected.reasoningEffort === "string") {
    selection.reasoningEffort = selected.reasoningEffort;
  }
  return {
    default: selection,
    groups,
    failureCount: safeInteger(body.failureCount, "models.failureCount"),
  };
}

function parseWriteResult(payload: unknown): DshWriteResult {
  const body = record(payload);
  const status = requiredString(body.status, "write.status");
  if (status === "accepted") return { status: "accepted" };
  if (status === "busy_or_writer_held") {
    return { status, errorCode: requiredString(body.errorCode, "write.errorCode") };
  }
  if (status === "rejected" || status === "delivery_unknown") {
    return { status, errorCode: requiredString(body.errorCode, "write.errorCode") };
  }
  throw new DshHostClientError("invalid_response", "dsh connector returned invalid write status");
}

function parseCreateSessionResult(payload: unknown): DshCreateSessionResult {
  const body = record(payload);
  const status = requiredString(body.status, "create.status");
  if (status === "accepted") {
    const sessionId = requiredString(body.sessionId, "create.sessionId");
    assertSessionId(sessionId);
    return {
      status,
      sessionId,
      agentPreset: typeof body.agentPreset === "string" ? body.agentPreset : null,
    };
  }
  if (status === "rejected" || status === "delivery_unknown") {
    return { status, errorCode: requiredString(body.errorCode, "create.errorCode") };
  }
  throw new DshHostClientError("invalid_response", "dsh connector returned invalid create status");
}

function parseSelectModelResult(payload: unknown): DshSelectModelResult {
  const body = record(payload);
  const status = requiredString(body.status, "selectModel.status");
  if (status === "accepted") {
    const selected = record(body.selected);
    const value: DshModelSelection = {
      provider: requiredString(selected.provider, "selectModel.provider"),
      model: requiredString(selected.model, "selectModel.model"),
      ...(typeof selected.reasoningEffort === "string"
        ? { reasoningEffort: selected.reasoningEffort }
        : {}),
    };
    return { status, selected: value };
  }
  if (status === "rejected" || status === "delivery_unknown") {
    return { status, errorCode: requiredString(body.errorCode, "selectModel.errorCode") };
  }
  throw new DshHostClientError("invalid_response", "dsh connector returned invalid model selection status");
}

function mapConnectorError(error: string): DshHostClientError {
  if (error === "unauthorized") {
    return new DshHostClientError("unauthorized", "dsh connector authentication failed");
  }
  if (error === "invalid_request") {
    return new DshHostClientError("invalid_request", "dsh connector rejected the request");
  }
  if (error === "unsupported") {
    return new DshHostClientError("contract_unsupported", "dsh connector operation is unavailable");
  }
  if (error === "operation_unavailable" || error === "read_unavailable") {
    return new DshHostClientError("provider_error", "dsh Host operation is unavailable");
  }
  return new DshHostClientError("provider_error", "dsh connector returned an unknown error");
}

async function assertPrivateRuntimePath(path: string, expected: "socket" | "file"): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DshHostClientError("host_unavailable", "dsh connector runtime is unavailable");
    }
    throw error;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && info.uid !== uid) {
    throw new DshHostClientError("unsafe_runtime_path", "dsh connector runtime owner mismatch");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new DshHostClientError("unsafe_runtime_path", "dsh connector runtime permissions are too broad");
  }
  if (expected === "socket" ? !info.isSocket() : !info.isFile()) {
    throw new DshHostClientError("unsafe_runtime_path", "dsh connector runtime path has the wrong type");
  }

  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || (uid !== null && parent.uid !== uid)) {
    throw new DshHostClientError("unsafe_runtime_path", "dsh connector runtime directory is not private");
  }
}

export class DshWebHostClient {
  readonly socketPath: string;
  readonly tokenPath: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: DshWebHostClientOptions) {
    this.socketPath = options.socketPath;
    this.tokenPath = options.tokenPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new DshHostClientError("invalid_request", "invalid dsh connector timeout");
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new DshHostClientError("invalid_request", "invalid dsh connector response limit");
    }
  }

  async health(signal?: AbortSignal): Promise<DshHostHealth> {
    const response = record(await this.request({ op: "health" }, this.timeoutMs, signal));
    const status = requiredString(response.status, "health.status");
    const protocol = safeInteger(response.protocol, "health.protocol", 1);
    const connectorVersion = requiredString(response.connectorVersion, "health.connectorVersion");
    if (status !== "mounted" || protocol !== 1 || connectorVersion !== DSH_CONNECTOR_VERSION) {
      throw new DshHostClientError("contract_unsupported", "unsupported dsh connector version or protocol");
    }
    return { status: "mounted", protocol, connectorVersion };
  }

  async listProjects(signal?: AbortSignal): Promise<DshProject[]> {
    return parseProjects(await this.request({ op: "projects.list" }, this.timeoutMs, signal));
  }

  async listSessions(signal?: AbortSignal): Promise<DshSessionSummary[]> {
    return parseSessions(await this.request({ op: "sessions.list" }, this.timeoutMs, signal));
  }

  async followSnapshot(sessionId: string, signal?: AbortSignal): Promise<DshFollowSnapshot> {
    assertSessionId(sessionId);
    return parseFollow(await this.request({ op: "history.follow", sessionId }, this.timeoutMs, signal));
  }

  /** Wait at most one bounded Host follow window for the next contiguous durable event. */
  async followWindow(sessionId: string, signal?: AbortSignal): Promise<DshLiveWindow> {
    assertSessionId(sessionId);
    const body = record(await this.request({ op: "history.followWindow", sessionId }, 16_000, signal));
    const cursor = safeInteger(body.cursor, "followWindow.cursor", -1);
    if (body.observed === false && body.event === undefined) return { observed: false, cursor };
    if (body.observed !== true) {
      throw new DshHostClientError("invalid_response", "dsh connector returned invalid live observation");
    }
    const event = eventMetadata(body.event);
    if (event.seq !== cursor + 1) {
      throw new DshHostClientError("invalid_response", "dsh connector live event is not contiguous");
    }
    return { observed: true, cursor, event };
  }

  async pageHistory(
    sessionId: string,
    throughSeq: number,
    beforeSeq?: number,
    signal?: AbortSignal,
  ): Promise<DshHistoryPage> {
    assertSessionId(sessionId);
    if (!Number.isSafeInteger(throughSeq) || throughSeq < -1) {
      throw new DshHostClientError("invalid_request", "invalid dsh history throughSeq");
    }
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      throw new DshHostClientError("invalid_request", "invalid dsh history beforeSeq");
    }
    const request: ConnectorRequest = { op: "history.page", sessionId, throughSeq };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    return parsePage(await this.request(request, this.timeoutMs, signal));
  }

  async listModels(signal?: AbortSignal): Promise<DshModelCatalog> {
    return parseModels(await this.request({ op: "models.catalog" }, this.timeoutMs, signal));
  }

  async submitPrompt(
    sessionId: string,
    requestId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<DshWriteResult> {
    assertSessionId(sessionId);
    if (!requestId || requestId.length > 160 || !text.trim() || text.length > 8192) {
      throw new DshHostClientError("invalid_request", "invalid dsh prompt request");
    }
    await this.health(signal);
    return parseWriteResult(await this.request(
      { op: "prompt.submit", sessionId, requestId, text },
      WRITE_TIMEOUT_MS,
      signal,
    ));
  }

  async createSession(
    workspaceId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DshCreateSessionResult> {
    assertSessionId(sessionId);
    if (!workspaceId || workspaceId.length > 200) {
      throw new DshHostClientError("invalid_request", "invalid dsh workspace id");
    }
    await this.health(signal);
    return parseCreateSessionResult(await this.request(
      { op: "session.create", workspaceId, sessionId },
      WRITE_TIMEOUT_MS,
      signal,
    ));
  }

  async selectModel(
    sessionId: string,
    selection: DshModelSelection,
    signal?: AbortSignal,
  ): Promise<DshSelectModelResult> {
    assertSessionId(sessionId);
    if (!selection.provider || selection.provider.length > 200 ||
      !selection.model || selection.model.length > 200 ||
      (selection.reasoningEffort !== undefined && selection.reasoningEffort.length > 100)) {
      throw new DshHostClientError("invalid_request", "invalid dsh model selection");
    }
    await this.health(signal);
    return parseSelectModelResult(await this.request({
      op: "session.selectModel",
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }, WRITE_TIMEOUT_MS, signal));
  }

  private async request(
    request: ConnectorRequest,
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await assertPrivateRuntimePath(this.socketPath, "socket");
    await assertPrivateRuntimePath(this.tokenPath, "file");
    const token = await readFile(this.tokenPath, "utf8");
    if (token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
      throw new DshHostClientError("unsafe_runtime_path", "dsh connector token file is invalid");
    }

    if (signal?.aborted) {
      throw new DshHostClientError("cancelled", "dsh connector request was cancelled");
    }

    const payload = JSON.stringify({ ...request, token }) + "\n";
    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;
      let response = "";
      const onAbort = () => {
        finish(() => reject(new DshHostClientError("cancelled", "dsh connector request was cancelled")));
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        socket.destroy();
        callback();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new DshHostClientError("timeout", "dsh connector request timed out")));
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk) => {
        response += chunk;
        if (Buffer.byteLength(response) > this.maxResponseBytes) {
          finish(() => reject(new DshHostClientError("invalid_response", "dsh connector response exceeded the limit")));
          return;
        }
        const newline = response.indexOf("\n");
        if (newline < 0) return;
        const line = response.slice(0, newline);
        finish(() => {
          try {
            const decoded = record(JSON.parse(line));
            if (decoded.ok !== true) {
              reject(mapConnectorError(typeof decoded.error === "string" ? decoded.error : "unknown"));
              return;
            }
            resolve(decoded);
          } catch (error) {
            reject(error instanceof DshHostClientError
              ? error
              : new DshHostClientError("invalid_response", "dsh connector returned invalid JSON"));
          }
        });
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        finish(() => reject(new DshHostClientError(
          error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET"
            ? "host_unavailable"
            : "provider_error",
          "dsh connector transport failed",
        )));
      });
      socket.on("end", () => {
        if (!settled) {
          finish(() => reject(new DshHostClientError("invalid_response", "dsh connector closed without a response")));
        }
      });
    });
  }
}

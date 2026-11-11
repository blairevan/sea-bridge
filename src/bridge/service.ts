import { APP_VERSION } from "../web/version.ts";
import type { WebAuth } from "../web/auth.ts";
import type { WebEvents } from "../web/events.ts";
import type { WebRedaction } from "../web/redaction.ts";
import type { WebOperation, WebOperationSource, WebStore } from "../web/store.ts";
import { dispatchWebOperation } from "../web/operations.ts";
import type { ExecutionEvidence, WebHistory, WebSession, WebSource } from "../web/sources/types.ts";
import {
  LocalBridgeError,
  readBoundedString,
  readClientApp,
  readSource,
  readUuid,
  type BridgeCatalogResponse,
  type BridgeHealthResponse,
  type BridgeLoginResponse,
  type BridgeOperationStatus,
  type BridgeSessionSummary,
  type BridgeSourceCatalog,
  type BridgeVerifyResponse,
} from "./types.ts";

/** Dependencies shared between WebRuntime and the private local Unix socket bridge. */
export interface LocalBridgeDependencies {
  store: WebStore;
  auth: WebAuth;
  events: WebEvents;
  redaction: WebRedaction;
  pepper: Uint8Array;
  sources: Partial<Record<WebOperationSource, WebSource>>;
  webBaseUrl: string | null;
}

const ORDERED_SOURCES: readonly WebOperationSource[] = ["codex", "antigravity", "dsh"];

/** Trusted local service delegating Sea-Bridge authentication and native multi-source sessions. */
export class LocalBridgeService {
  /** Compose local bridge operations over the shared Sea-Bridge Web runtime components. */
  constructor(private readonly deps: LocalBridgeDependencies) {}

  /** Report bridge readiness and whether an administrator account has been provisioned. */
  health(): BridgeHealthResponse {
    return {
      ready: true,
      version: APP_VERSION,
      accountConfigured: this.deps.auth.accountConfigured(),
    };
  }

  /** Verify administrator credentials and create a 30-day device session on behalf of ToolHub. */
  async login(body: Record<string, unknown>): Promise<BridgeLoginResponse> {
    if (!this.deps.auth.accountConfigured()) {
      throw new LocalBridgeError(503, "account_not_configured");
    }
    const username = readBoundedString(body.username, 64) ?? "";
    const password = readBoundedString(body.password, 256, { trim: false }) ?? "";
    const bucket = readBoundedString(body.bucket, 64) ?? "toolhub";
    const deviceName = this.deps.redaction.storage(readBoundedString(body.deviceName, 80, { nullable: true }) ?? "Web · Browser");
    const loginIp = readBoundedString(body.loginIp, 64, { nullable: true, allowEmpty: true }) ?? "";
    const clientApp = body.clientApp === undefined ? "toolhub" : readClientApp(body.clientApp);

    const loggedIn = await this.deps.auth.login(username, password, `bridge:${bucket}`, deviceName, {
      loginIp,
      clientApp,
    });
    if (!loggedIn) {
      throw new LocalBridgeError(401, "login_failed");
    }
    return loggedIn;
  }

  /** Validate an existing session token and optional double-submit CSRF token pair. */
  verify(body: Record<string, unknown>): BridgeVerifyResponse {
    const accountConfigured = this.deps.auth.accountConfigured();
    const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";
    const requireCsrf = Boolean(body.requireCsrf);
    const device = sessionToken ? this.deps.auth.authenticate(sessionToken) : null;
    if (!device) {
      return { authenticated: false, csrfValid: false, accountConfigured, device: null };
    }
    const csrfCookie = typeof body.csrfCookie === "string" ? body.csrfCookie.trim() : "";
    const csrfHeader = typeof body.csrfHeader === "string" ? body.csrfHeader.trim() : "";
    const csrfValid = requireCsrf ? this.deps.auth.verifyCsrf(device.id, csrfCookie, csrfHeader) : true;
    return { authenticated: true, csrfValid, accountConfigured, device };
  }

  /** Revoke a paired device session immediately across both Sea-Bridge and ToolHub. */
  logout(body: Record<string, unknown>): { revoked: boolean } {
    const deviceId = readBoundedString(body.deviceId, 100) ?? "";
    const revoked = this.deps.store.revokeDevice(deviceId, Date.now());
    this.deps.events.revoke(deviceId);
    return { revoked };
  }

  /** Aggregate available native execution sources, projects, and model catalogs. */
  async catalog(): Promise<BridgeCatalogResponse> {
    const sources: BridgeSourceCatalog[] = [];
    for (const sourceName of ORDERED_SOURCES) {
      const source = this.deps.sources[sourceName];
      if (!source) continue;
      const [projects, models] = await Promise.all([
        source.projects().catch(() => []),
        source.models().catch(() => []),
      ]);
      sources.push({
        source: sourceName,
        capabilities: source.capabilities(),
        projects: projects.slice(0, 2000),
        models: models.slice(0, 2000),
      });
    }
    return { webBaseUrl: this.deps.webBaseUrl, sources };
  }

  /** Create a native session and dispatch its initial task prompt idempotently. */
  async createSession(body: Record<string, unknown>): Promise<WebOperation> {
    const operationId = readUuid(body.operationId);
    const sourceName = readSource(body.source);
    const source = this.deps.sources[sourceName];
    if (!source) throw new LocalBridgeError(503, "source_unavailable");

    const projectId = readBoundedString(body.projectId, 200) ?? "";
    const modelId = readBoundedString(body.modelId, 2000, { nullable: true });
    const reasoningEffort = readBoundedString(body.reasoningEffort, 80, { nullable: true });
    if (reasoningEffort !== null && !/^[a-zA-Z0-9_-]{1,80}$/.test(reasoningEffort)) {
      throw new LocalBridgeError(400, "invalid_reasoning_effort");
    }
    const prompt = readBoundedString(body.prompt, 32000, { trim: false }) ?? "";
    if (!prompt.trim()) throw new LocalBridgeError(400, "invalid_field");
    const deviceId = readBoundedString(body.deviceId, 100, { nullable: true }) ?? "toolhub-local";

    try {
      return await dispatchWebOperation(
        {
          operationId,
          source: sourceName,
          kind: "create",
          targetId: null,
          projectId,
          modelId,
          reasoningEffort,
          prompt,
        },
        deviceId,
        source,
        this.deps.store,
        this.deps.pepper,
        this.deps.redaction,
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "dispatch_failed";
      if (code === "operation_conflict") throw new LocalBridgeError(409, "operation_conflict");
      throw new LocalBridgeError(503, code);
    }
  }

  /** Append a follow-up/rework prompt to an existing native session idempotently. */
  async sendMessage(rawSource: string, rawSessionId: string, body: Record<string, unknown>): Promise<WebOperation> {
    const sourceName = readSource(rawSource);
    const sessionId = readBoundedString(rawSessionId, 200) ?? "";
    const source = this.deps.sources[sourceName];
    if (!source) throw new LocalBridgeError(503, "source_unavailable");

    const operationId = readUuid(body.operationId);
    const prompt = readBoundedString(body.prompt, 32000, { trim: false }) ?? "";
    if (!prompt.trim()) throw new LocalBridgeError(400, "invalid_field");
    const deviceId = readBoundedString(body.deviceId, 100, { nullable: true }) ?? "toolhub-local";

    try {
      return await dispatchWebOperation(
        {
          operationId,
          source: sourceName,
          kind: "send",
          targetId: sessionId,
          projectId: null,
          modelId: null,
          prompt,
        },
        deviceId,
        source,
        this.deps.store,
        this.deps.pepper,
        this.deps.redaction,
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "dispatch_failed";
      if (code === "operation_conflict") throw new LocalBridgeError(409, "operation_conflict");
      throw new LocalBridgeError(503, code);
    }
  }

  /** Inspect an operation record together with current runtime execution evidence. */
  async getOperation(rawId: string): Promise<BridgeOperationStatus> {
    const id = readUuid(rawId);
    const operation = this.deps.store.getOperation(id);
    if (!operation) throw new LocalBridgeError(404, "operation_not_found");

    let execution: ExecutionEvidence = { state: "unknown", exact: false };
    if (operation.sessionId && ["queued", "accepted", "delivery_unknown"].includes(operation.state)) {
      const source = this.deps.sources[operation.source];
      if (source?.execution) {
        try {
          execution = await source.execution(operation.sessionId, operation.turnId, operation.createdAt);
        } catch {
          execution = { state: "unknown", exact: false };
        }
      }
    }
    return { operation, execution };
  }

  /** Summarize a session's execution state and latest assistant reply for ToolHub task synchronization. */
  async getSessionSummary(rawSource: string, rawSessionId: string): Promise<BridgeSessionSummary> {
    const sourceName = readSource(rawSource);
    const sessionId = readBoundedString(rawSessionId, 200) ?? "";
    const source = this.deps.sources[sourceName];
    if (!source) throw new LocalBridgeError(503, "source_unavailable");

    const sessionItems = await source.sessions({ sessionId, limit: 50 }).catch(() => [] as WebSession[]);
    const matched = sessionItems.find((item) => item.id === sessionId) ?? null;

    let history: WebHistory | null = null;
    try {
      history = await source.history(sessionId, null, 20);
    } catch {
      history = null;
    }

    const exec = !matched && !history && source.execution
      ? await source.execution(sessionId, null).catch(() => null)
      : null;

    const activeFromExec = exec?.state === "running" || exec?.state === "waiting_external_approval";
    if (!matched && !history && !activeFromExec) {
      return {
        exists: false,
        state: "unknown",
        title: null,
        updatedAt: null,
        lastAssistantId: null,
        lastAssistantText: null,
        pendingApprovalsCount: 0,
        activeTurnId: null,
        activeExecution: null,
        canOpenDesktop: false,
      };
    }

    const state: BridgeSessionSummary["state"] = history?.sessionState
      ?? matched?.state
      ?? (exec?.state === "running" || exec?.state === "waiting_external_approval" ? exec.state : "unknown");

    let lastAssistantId: string | null = null;
    let lastAssistantText: string | null = null;
    const messages = history?.messages ?? [];
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      const msg = messages[idx];
      if (msg && msg.role === "assistant" && msg.text.trim().length > 0) {
        lastAssistantId = msg.id;
        lastAssistantText = this.deps.redaction.storage(msg.text.slice(0, 4000));
        break;
      }
    }

    const activeExecution = history?.executionControl?.activeExecutionId && history.executionControl.activeEpoch
      ? { executionId: history.executionControl.activeExecutionId, epoch: history.executionControl.activeEpoch }
      : null;

    return {
      exists: true,
      state,
      title: matched?.title ? this.deps.redaction.storage(matched.title) : null,
      updatedAt: matched?.updatedAt ?? null,
      lastAssistantId,
      lastAssistantText,
      pendingApprovalsCount: history?.pendingApprovals?.length ?? (state === "waiting_external_approval" ? 1 : 0),
      activeTurnId: history?.turnControl?.activeTurnId ?? null,
      activeExecution,
      canOpenDesktop: sourceName === "codex" && Boolean(source.capabilities().desktopOpenEnabled),
    };
  }

  /** Best-effort interrupt of an active Codex or Antigravity turn when a task is cancelled. */
  async interruptSession(
    rawSource: string,
    rawSessionId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: "interrupting" | "already_idle" }> {
    const sourceName = readSource(rawSource);
    const sessionId = readBoundedString(rawSessionId, 200) ?? "";
    const source = this.deps.sources[sourceName];
    if (!source) throw new LocalBridgeError(503, "source_unavailable");

    if (sourceName === "dsh") {
      return { status: "already_idle" };
    }

    const summary = await this.getSessionSummary(sourceName, sessionId).catch(() => null);
    if (sourceName === "antigravity") {
      const expectedExecutionId = readBoundedString(body.expectedExecutionId, 200, { nullable: true })
        ?? summary?.activeExecution?.executionId
        ?? "";
      const rawEpoch = typeof body.expectedEpoch === "number" && Number.isSafeInteger(body.expectedEpoch) && body.expectedEpoch > 0
        ? body.expectedEpoch
        : (summary?.activeExecution?.epoch ?? 0);
      if (!expectedExecutionId || !rawEpoch || !source.interruptExecution) {
        return { status: "already_idle" };
      }
      try {
        return await source.interruptExecution(sessionId, expectedExecutionId, rawEpoch);
      } catch {
        return { status: "already_idle" };
      }
    }

    const expectedTurnId = readBoundedString(body.expectedTurnId, 200, { nullable: true })
      ?? summary?.activeTurnId
      ?? "";
    if (!expectedTurnId || !source.interrupt) {
      return { status: "already_idle" };
    }
    try {
      return await source.interrupt(sessionId, expectedTurnId);
    } catch {
      return { status: "already_idle" };
    }
  }

  /** Request opening a Codex session inside the local macOS Codex Desktop app. */
  async openDesktop(rawSessionId: string): Promise<{ status: "open_requested" }> {
    const sessionId = readBoundedString(rawSessionId, 200) ?? "";
    const source = this.deps.sources.codex;
    if (!source?.openDesktop) {
      throw new LocalBridgeError(503, "desktop_open_unavailable");
    }
    try {
      await source.openDesktop(sessionId);
      return { status: "open_requested" };
    } catch (error) {
      const code = error instanceof Error ? error.message : "desktop_open_failed";
      if (code === "invalid_session_id") throw new LocalBridgeError(400, code);
      if (code === "session_missing") throw new LocalBridgeError(404, code);
      if (code === "desktop_open_busy" || code === "first_turn_owned") throw new LocalBridgeError(409, code);
      throw new LocalBridgeError(503, "desktop_open_failed");
    }
  }
}

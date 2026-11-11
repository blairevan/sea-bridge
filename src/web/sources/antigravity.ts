import type { AntigravityApprovalBridge } from "../../antigravity/approval-bridge.ts";
import type { AntigravityCapabilityGate } from "../../antigravity/capabilities.ts";
import type { AntigravityConfig } from "../../antigravity/config.ts";
import type { AntigravityDesktopReader } from "../../antigravity/desktop-reader.ts";
import type { AntigravityModelCatalog } from "../../antigravity/model-catalog.ts";
import { projectManagedWebHistory, projectManagedWebSession } from "../../antigravity/projection.ts";
import type { AntigravitySessionManager } from "../../antigravity/session-manager.ts";
import type { AntigravityStore } from "../../antigravity/store.ts";
import type { WebStore } from "../store.ts";
import type {
  CatalogItem,
  CreateRequest,
  ExecutionEvidence,
  SessionListOptions,
  SourceResult,
  SourceSendOptions,
  WebHistory,
  WebSession,
  WebSource,
  WebSourceCapabilities,
  WebSourceStatusState,
} from "./types.ts";

/**
 * WebSource adapter for Antigravity (`agy acp` managed sessions + `Antigravity.app` Desktop read-only sessions).
 * Deduplicates by `sessionId` with managed `sea_bridge` sessions taking precedence over `desktop` read-only sessions.
 */
export class AntigravityWebSource implements WebSource {
  private hasModelsCached = false;

  constructor(
    private readonly deps: {
      config: AntigravityConfig;
      store: AntigravityStore;
      webStore?: WebStore | undefined;
      capabilityGate: AntigravityCapabilityGate;
      modelCatalog: AntigravityModelCatalog;
      desktopReader: AntigravityDesktopReader;
      approvalBridge: AntigravityApprovalBridge;
      sessionManager: AntigravitySessionManager;
    }
  ) {}

  statusState(): WebSourceStatusState {
    return this.deps.capabilityGate.toStatusState();
  }

  statusDetails(): Record<string, string> {
    const snap = this.deps.capabilityGate.getSnapshot();
    return {
      cli: snap.agentVersion ?? "1.5.2",
      desktopRead: this.deps.config.desktopReadEnabled ? "enabled" : "disabled",
      externalWrite: this.deps.config.externalSessionsEnabled ? "enabled" : "disabled",
      write: this.deps.config.writeEnabled ? "enabled" : "disabled",
      ...(snap.lastError ? { lastError: snap.lastError } : {}),
    };
  }

  async probeCapabilities(): Promise<void> {
    if (!this.deps.config.enabled) return;
    const models = await this.deps.modelCatalog.listModels();
    this.hasModelsCached = models.length > 0;
  }

  capabilities(): WebSourceCapabilities {
    const hasProjects = this.deps.store.listProjects().length > 0;
    return this.deps.capabilityGate.toWebCapabilities({
      hasProjects,
      hasModels: this.hasModelsCached || this.deps.config.enabled,
    });
  }

  async projects(): Promise<CatalogItem[]> {
    return this.deps.store.listProjects().map((p) => ({
      id: p.id,
      name: p.name,
    }));
  }

  async models(): Promise<CatalogItem[]> {
    const list = await this.deps.modelCatalog.listModels();
    this.hasModelsCached = list.length > 0;
    return list;
  }

  async sessions(options: SessionListOptions = {}): Promise<WebSession[]> {
    if (!this.deps.config.enabled) return [];

    const merged = new Map<string, WebSession>();

    // 1. SeaBridge-managed and P4-adopted sessions take precedence
    const managedRecords = this.deps.store.listSessions(500);
    for (const rec of managedRecords) {
      const pendingApprovals = this.deps.store.listPendingApprovals(rec.sessionId);
      const isDesktopOrigin = rec.sessionOrigin === "desktop";
      const extInfo = (isDesktopOrigin || rec.clientTarget === "cli") && this.deps.config.desktopReadEnabled
        ? this.deps.desktopReader.inspectAnyExternalSession(rec.sessionId)
        : null;
      const hasActiveTurn = this.deps.sessionManager.hasActiveTurn(rec.sessionId);
      const waitingUserInput = Boolean(extInfo?.waitingUserInput && !hasActiveTurn);
      let effectiveRec = rec;
      if (extInfo?.externallyRunning && !waitingUserInput && (rec.status === "idle" || rec.status === "unknown")) {
        effectiveRec = { ...rec, status: "running" as const };
      } else if (
        rec.status === "unknown" &&
        !hasActiveTurn &&
        (!isDesktopOrigin || !extInfo?.found || !extInfo.externallyRunning)
      ) {
        effectiveRec = { ...rec, status: "idle" as const };
        this.deps.store.upsertSession(effectiveRec);
      }
      const canWrite = isDesktopOrigin
        ? Boolean(this.deps.config.writeEnabled && this.deps.config.externalSessionsEnabled && rec.projectId !== null)
        : this.deps.config.writeEnabled;
      const projected = projectManagedWebSession(effectiveRec, {
        catalog: this.deps.modelCatalog,
        hasPendingApproval: pendingApprovals.length > 0,
        sendEnabled: canWrite,
        waitingUserInput,
      });
      merged.set(projected.id, projected);
    }

    // 2. External Desktop & CLI sessions fill in non-managed conversation IDs
    if (this.deps.config.desktopReadEnabled) {
      const externalSessions = this.deps.desktopReader.listExternalSessions(500);
      for (const extSess of externalSessions) {
        if (!merged.has(extSess.id)) {
          const canSendExternal = Boolean(
            this.deps.config.writeEnabled &&
              this.deps.config.externalSessionsEnabled &&
              extSess.projectId !== null &&
              extSess.state !== "running"
          );
          merged.set(extSess.id, {
            ...extSess,
            sendEnabled: canSendExternal,
          });
        }
      }
    }

    let items = Array.from(merged.values());

    if (options.sessionIds && options.sessionIds.length > 0) {
      const allowed = new Set(options.sessionIds);
      items = items.filter((item) => allowed.has(item.id));
    }
    if (options.sessionId) {
      items = items.filter((item) => item.id === options.sessionId);
    }
    if (options.query) {
      const q = options.query.toLowerCase();
      items = items.filter((item) => item.title.toLowerCase().includes(q));
    }
    if (options.creationClient) {
      items = items.filter((item) => (item.creationClient?.kind ?? "unknown") === options.creationClient);
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const offset = options.offset ?? 0;
    if (options.limit !== undefined && options.limit > 0) {
      return items.slice(offset, offset + options.limit);
    }
    return offset > 0 ? items.slice(offset) : items;
  }

  async history(id: string, _cursor: string | null, limit: number): Promise<WebHistory> {
    const managed = this.deps.store.getSession(id);
    if (managed) {
      const records = this.deps.store.listMessages(id, managed.snapshotGeneration);
      const pendingApprovals = this.deps.store.listPendingApprovals(id);
      const executionControl = this.deps.sessionManager.getExecutionControl(id);
      const externalHistory =
        (managed.sessionOrigin === "desktop" || managed.clientTarget === "cli") && this.deps.config.desktopReadEnabled
          ? this.deps.desktopReader.readExternalHistory(id, limit)
          : null;
      const hasActiveTurn = this.deps.sessionManager.hasActiveTurn(id);
      const waitingUserInput = Boolean(externalHistory?.sessionState === "waiting_user_input" && !hasActiveTurn);
      let effectiveSession = managed;
      if (externalHistory?.sessionState === "running" && (managed.status === "idle" || managed.status === "unknown")) {
        effectiveSession = { ...managed, status: "running" as const };
      } else if (
        managed.status === "unknown" &&
        !hasActiveTurn &&
        (managed.sessionOrigin !== "desktop" || !externalHistory || externalHistory.sessionState === "idle")
      ) {
        effectiveSession = { ...managed, status: "idle" as const };
        this.deps.store.upsertSession(effectiveSession);
      }
      return projectManagedWebHistory({
        session: effectiveSession,
        records,
        pendingApprovals,
        executionControl,
        catalog: this.deps.modelCatalog,
        limit,
        waitingUserInput,
        ...(externalHistory
          ? {
              baseMessages: externalHistory.messages,
              ...(externalHistory.activeTurnItems ? { baseActiveTurnItems: externalHistory.activeTurnItems } : {}),
            }
          : {}),
      });
    }

    if (this.deps.config.desktopReadEnabled) {
      const externalHistory = this.deps.desktopReader.readExternalHistory(id, limit);
      if (externalHistory) {
        return {
          ...externalHistory,
          executionControl: {
            activeExecutionId: null,
            activeEpoch: null,
            interrupt: { status: "unavailable", reason: "provider_unverified" },
          },
          pendingApprovals: [],
        };
      }
    }

    throw new Error("session_missing");
  }

  async execution(id: string, turnId: string | null): Promise<ExecutionEvidence> {
    const pending = this.deps.store.listPendingApprovals(id);
    if (pending.length > 0) {
      return { state: "waiting_external_approval", exact: true };
    }
    if (turnId) {
      const exec = this.deps.store.getExecution(turnId);
      if (exec && exec.sessionId === id) {
        if (exec.status === "starting" || exec.status === "running" || exec.status === "cancelling") {
          return { state: "running", exact: true };
        }
        if (["completed", "cancelled", "incomplete", "failed"].includes(exec.status)) {
          return { state: "session_ended", exact: true };
        }
      }
    }
    const managed = this.deps.store.getSession(id);
    if (managed?.status === "running" || managed?.status === "cancelling") {
      return { state: "running", exact: false };
    }
    return { state: "unknown", exact: false };
  }

  async create(input: CreateRequest): Promise<SourceResult> {
    if (!this.deps.config.enabled || !this.deps.config.writeEnabled) {
      return { state: "failed", sessionId: null, errorCode: "write_disabled" };
    }
    return await this.deps.sessionManager.create(input);
  }

  async send(id: string, operationId: string, prompt: string, options?: SourceSendOptions): Promise<SourceResult> {
    if (!this.deps.config.enabled || !this.deps.config.writeEnabled) {
      return { state: "failed", sessionId: id, errorCode: "write_disabled" };
    }
    const managed = this.deps.store.getSession(id);
    if (!managed) {
      if (this.deps.config.desktopReadEnabled && this.deps.desktopReader.getExternalSession(id)) {
        if (!this.deps.config.externalSessionsEnabled) {
          return { state: "failed", sessionId: id, errorCode: "desktop_session_read_only" };
        }
        return await this.deps.sessionManager.send(id, operationId, prompt, options);
      }
      return { state: "failed", sessionId: id, errorCode: "session_not_found" };
    }
    return await this.deps.sessionManager.send(id, operationId, prompt, options);
  }

  async updateModel(
    id: string,
    modelId: string,
    reasoningEffort?: string | null
  ): Promise<{ status: "updated"; model: { id: string; displayName?: string }; reasoningEffort?: string }> {
    if (!this.deps.config.enabled || !this.deps.config.writeEnabled) {
      throw new Error("model_update_unavailable");
    }
    const managed = this.deps.store.getSession(id);
    if (!managed) {
      if (this.deps.config.desktopReadEnabled && this.deps.desktopReader.getExternalSession(id)) {
        if (!this.deps.config.externalSessionsEnabled) {
          throw new Error("model_update_unverified");
        }
      } else {
        throw new Error("session_missing");
      }
    }
    try {
      return await this.deps.sessionManager.updateModel(id, modelId, reasoningEffort);
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (code === "session_busy") throw new Error("model_update_busy");
      if (code === "invalid_model") throw new Error("model_unavailable");
      if (code === "desktop_session_read_only" || code === "invalid_project") throw new Error("model_update_unverified");
      if (code === "session_not_found") throw new Error("session_missing");
      throw new Error("model_update_unavailable");
    }
  }

  async interruptExecution(
    id: string,
    expectedExecutionId: string,
    expectedEpoch: number
  ): Promise<{ status: "interrupting" }> {
    if (!this.deps.config.enabled || !this.deps.config.writeEnabled) {
      throw new Error("interrupt_provider_unavailable");
    }
    const managed = this.deps.store.getSession(id);
    if (!managed) {
      if (this.deps.config.desktopReadEnabled && this.deps.desktopReader.getExternalSession(id)) {
        throw new Error("interrupt_not_owned");
      }
      throw new Error("session_missing");
    }
    return await this.deps.sessionManager.interruptExecution(id, expectedExecutionId, expectedEpoch);
  }

  async decideApproval(
    sessionId: string,
    approvalId: string,
    optionId: string,
    decidedBy: string
  ): Promise<{ status: "decided" | "already_decided" | "expired"; optionId?: string | null }> {
    const res = this.deps.approvalBridge.decide({
      sessionId,
      approvalId,
      optionId,
      decidedBy,
    });
    if (res.status === "not_found") throw new Error("approval_not_found");
    if (res.status === "invalid_option") throw new Error("invalid_option");
    return {
      status: res.status,
      optionId: res.approval.selectedOptionId,
    };
  }
}

import type { AcpInitializeResult } from "./protocol.ts";
import type { WebSourceCapabilities, WebSourceStatusState } from "../web/sources/types.ts";

export interface AntigravityCapabilitySnapshot {
  initialized: boolean;
  protocolCompatible: boolean;
  agentVersion: string | null;
  loadSupported: boolean;
  resumeSupported: boolean;
  listSupported: boolean;
  closeSupported: boolean;
  lastError: string | null;
  updatedAt: number;
}

/** Gate Antigravity runtime capabilities on verified ACP handshake and configuration flags. */
export class AntigravityCapabilityGate {
  private snapshot: AntigravityCapabilitySnapshot = {
    initialized: false,
    protocolCompatible: true,
    agentVersion: null,
    loadSupported: false,
    resumeSupported: false,
    listSupported: false,
    closeSupported: false,
    lastError: null,
    updatedAt: 0,
  };

  constructor(
    private readonly options: {
      enabled: boolean;
      writeEnabled: boolean;
      desktopReadEnabled: boolean;
      externalSessionsEnabled?: boolean;
    }
  ) {}

  /** Record a completed `initialize` handshake and check protocol version compatibility. */
  recordHandshake(init: AcpInitializeResult, now = Date.now()): AntigravityCapabilitySnapshot {
    if (init.protocolVersion !== 1) {
      this.snapshot = {
        initialized: true,
        protocolCompatible: false,
        agentVersion: init.agentInfo?.version ?? null,
        loadSupported: false,
        resumeSupported: false,
        listSupported: false,
        closeSupported: false,
        lastError: `unsupported_protocol_version:${init.protocolVersion}`,
        updatedAt: now,
      };
      return this.snapshot;
    }

    const sessionCaps = init.agentCapabilities?.sessionCapabilities ?? {};
    this.snapshot = {
      initialized: true,
      protocolCompatible: true,
      agentVersion: init.agentInfo?.version ?? null,
      loadSupported: Boolean(init.agentCapabilities?.loadSession),
      resumeSupported: Boolean(sessionCaps.resume),
      listSupported: Boolean(sessionCaps.list),
      closeSupported: Boolean(sessionCaps.close),
      lastError: null,
      updatedAt: now,
    };
    return this.snapshot;
  }

  /** Record a probe or handshake error. */
  recordFailure(reason: string, now = Date.now()): void {
    this.snapshot = {
      ...this.snapshot,
      lastError: reason,
      updatedAt: now,
    };
  }

  /** Return the current internal capability snapshot. */
  getSnapshot(): AntigravityCapabilitySnapshot {
    return { ...this.snapshot };
  }

  /** Project capabilities for WebSource status and UI gating. */
  toWebCapabilities(params: { hasProjects: boolean; hasModels: boolean }): WebSourceCapabilities {
    if (!this.options.enabled) {
      return {
        sessionsReadable: false,
        projectsReadable: false,
        modelsReadable: false,
        historyReadable: false,
        completeUserHistoryReadable: false,
        finalReplyReadable: false,
        createEnabled: false,
        desktopCreateEnabled: false,
        sendEnabled: false,
        modelUpdateEnabled: false,
        approvalTransport: null,
      };
    }

    const canWrite =
      this.options.writeEnabled &&
      this.snapshot.protocolCompatible &&
      params.hasProjects;

    return {
      sessionsReadable: true,
      projectsReadable: params.hasProjects,
      modelsReadable: params.hasModels,
      historyReadable: true,
      completeUserHistoryReadable: true,
      finalReplyReadable: true,
      createEnabled: canWrite,
      desktopCreateEnabled: canWrite && (this.options.externalSessionsEnabled ?? true),
      sendEnabled: canWrite,
      modelUpdateEnabled: canWrite,
      approvalTransport: canWrite ? "web" : null,
    };
  }

  /** Return WebSource status state. */
  toStatusState(): WebSourceStatusState {
    if (!this.options.enabled) return "unavailable";
    if (!this.snapshot.protocolCompatible) return "protocol_incompatible";
    if (this.snapshot.lastError && !this.snapshot.initialized) return "unavailable";
    return "limited";
  }
}

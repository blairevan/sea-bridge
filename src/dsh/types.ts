export type DshCapabilityName =
  | "transport"
  | "observation"
  | "projects"
  | "models"
  | "reply"
  | "creation";

export type DshCapabilityStatus = "available" | "partial" | "unavailable";

export interface DshCapabilityState {
  name: DshCapabilityName;
  status: DshCapabilityStatus;
  reason: string | null;
}

export const DSH_CONNECTOR_VERSION = "0.2.0";

export interface DshHostHealth {
  status: "mounted";
  protocol: number;
  connectorVersion: string;
}

export interface DshProject {
  id: string;
  title: string;
  sessionCount: number;
}

export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
}

export interface DshEventMetadata {
  type: string;
  seq: number;
  time: number;
  reasonKind?: "completed" | "error" | "aborted" | "max-tokens" | "stop" | "tool-calls" | "unknown";
}

export interface DshFollowSnapshot {
  cursor: number;
  hasMore: boolean;
  truncated: boolean;
  events: DshEventMetadata[];
}

export interface DshHistoryPage {
  hasMore: boolean;
  truncated: boolean;
  events: DshEventMetadata[];
}

export type DshLiveWindow =
  | { observed: false; cursor: number }
  | { observed: true; cursor: number; event: DshEventMetadata };

export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshModel {
  id: string;
  name: string;
}

export interface DshModelGroup {
  id: string;
  name: string;
  models: DshModel[];
}

export interface DshModelCatalog {
  default: DshModelSelection;
  groups: DshModelGroup[];
  failureCount: number;
}

export type DshHostClientErrorCode =
  | "host_unavailable"
  | "unauthorized"
  | "timeout"
  | "cancelled"
  | "invalid_request"
  | "invalid_response"
  | "contract_unsupported"
  | "provider_error"
  | "unsafe_runtime_path";

export class DshHostClientError extends Error {
  constructor(
    readonly code: DshHostClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DshHostClientError";
  }
}

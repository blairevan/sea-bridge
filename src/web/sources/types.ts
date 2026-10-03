import type { OperationState } from "../store.ts";

/** Independent capability flags prevent a partial source appearing fully available. */
export interface WebSourceCapabilities {
  sessionsReadable: boolean; projectsReadable: boolean; modelsReadable: boolean; historyReadable: boolean;
  completeUserHistoryReadable: boolean; finalReplyReadable: boolean; createEnabled: boolean; sendEnabled: boolean;
  desktopOpenEnabled?: boolean;
  approvalTransport: "telegram" | null;
}
/** Source-owned identity plus evidence-based display metadata. */
export interface WebSession {
  source: "codex" | "dsh"; id: string; title: string; updatedAt: number; projectId: string | null;
  state: "running" | "idle" | "unknown" | "waiting_external_approval"; startedAt?: number; sendEnabled: boolean;
}
/** Executed conversation and explicitly marked native queue inputs share safe message fields. */
export interface WebMessage { id: string; role: "user" | "assistant"; text: string; createdAt?: number | null; durationMs?: number; deliveryState?: "queued" | "queue_unknown"; }
/** Bounded history and an independent current queue snapshot with an opaque history cursor. */
export interface WebHistory { messages: WebMessage[]; cursor: string | null; completeUserHistory: boolean; queuedMessages?: WebMessage[]; queueUnavailable?: boolean; sessionState?: WebSession["state"]; activeTurnStartedAt?: number; }
/** Catalog items preserve machine IDs while display fields can be redacted. */
export interface CatalogItem { id: string; name: string; }
/** Runtime evidence is separate from durable delivery state. */
export interface ExecutionEvidence {
  state: "running" | "waiting_external_approval" | "session_ended" | "unknown";
  exact: boolean;
}
/** Submission acceptance does not imply source execution completion. */
export interface SourceResult { state: OperationState; sessionId: string | null; turnId?: string; errorCode?: string; }
/** Explicit per-request model choice and early persistence callback. */
export interface CreateRequest {
  operationId: string; projectId: string; modelId: string | null; prompt: string;
  onSessionKnown: (id: string) => void;
}
/** Web adapter boundary independent of Telegram IDs and preferences. */
export interface WebSource {
  attachment?(id: string, messageId: string, index: number): Promise<{ bytes: Uint8Array; contentType: string }>;
  openDesktop?(id: string): Promise<void>;
  capabilities(): WebSourceCapabilities;
  sessions(): Promise<WebSession[]>;
  projects(): Promise<CatalogItem[]>;
  models(): Promise<CatalogItem[]>;
  history(id: string, cursor: string | null, limit: number): Promise<WebHistory>;
  execution?(id: string, turnId: string | null, submittedAt?: number): Promise<ExecutionEvidence>;
  create(input: CreateRequest): Promise<SourceResult>;
  send(id: string, operationId: string, prompt: string): Promise<SourceResult>;
}

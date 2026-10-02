import type { OperationState } from "../store.ts";

/** Independent capability flags prevent a partial source appearing fully available. */
export interface WebSourceCapabilities {
  sessionsReadable: boolean; projectsReadable: boolean; modelsReadable: boolean; historyReadable: boolean;
  completeUserHistoryReadable: boolean; finalReplyReadable: boolean; createEnabled: boolean; sendEnabled: boolean;
  approvalTransport: "telegram" | null;
}
/** Source-owned identity plus evidence-based display metadata. */
export interface WebSession {
  source: "codex" | "dsh"; id: string; title: string; updatedAt: number; projectId: string | null;
  state: "running" | "unknown" | "waiting_external_approval"; sendEnabled: boolean;
}
/** Only verified user text and visible final assistant text enter the timeline. */
export interface WebMessage { id: string; role: "user" | "assistant"; text: string; }
/** Bounded history page with an opaque continuation cursor. */
export interface WebHistory { messages: WebMessage[]; cursor: string | null; completeUserHistory: boolean; }
/** Catalog items preserve machine IDs while display fields can be redacted. */
export interface CatalogItem { id: string; name: string; }
/** Submission acceptance does not imply source execution completion. */
export interface SourceResult { state: OperationState; sessionId: string | null; turnId?: string; errorCode?: string; }
/** Explicit per-request model choice and early persistence callback. */
export interface CreateRequest {
  operationId: string; projectId: string; modelId: string | null; prompt: string;
  onSessionKnown: (id: string) => void;
}
/** Web adapter boundary independent of Telegram IDs and preferences. */
export interface WebSource {
  capabilities(): WebSourceCapabilities;
  sessions(): Promise<WebSession[]>;
  projects(): Promise<CatalogItem[]>;
  models(): Promise<CatalogItem[]>;
  history(id: string, cursor: string | null, limit: number): Promise<WebHistory>;
  create(input: CreateRequest): Promise<SourceResult>;
  send(id: string, operationId: string, prompt: string): Promise<SourceResult>;
}

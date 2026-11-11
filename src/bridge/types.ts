import type { CatalogItem, ExecutionEvidence, WebSourceCapabilities } from "../web/sources/types.ts";
import type { WebClientApp, WebDevice, WebOperation, WebOperationSource } from "../web/store.ts";

/** Structured error returned by the private local Unix socket bridge. */
export class LocalBridgeError extends Error {
  /** Create an HTTP-mapped error with a stable machine error code. */
  constructor(readonly status: number, readonly errorCode: string) {
    super(errorCode);
  }
}

/** Health response exposed over `/v1/health`. */
export interface BridgeHealthResponse {
  ready: true;
  version: string;
  accountConfigured: boolean;
}

/** Successful delegated login payload returned over `/v1/auth/login`. */
export interface BridgeLoginResponse {
  device: WebDevice;
  sessionToken: string;
  csrfToken: string;
}

/** Session and optional CSRF verification result returned over `/v1/auth/verify`. */
export interface BridgeVerifyResponse {
  authenticated: boolean;
  csrfValid: boolean;
  accountConfigured: boolean;
  device: WebDevice | null;
}

/** Source catalog entry aggregating projects, models, and runtime capabilities. */
export interface BridgeSourceCatalog {
  source: WebOperationSource;
  capabilities: WebSourceCapabilities;
  projects: CatalogItem[];
  models: CatalogItem[];
}

/** Multi-source catalog response returned over `/v1/catalog`. */
export interface BridgeCatalogResponse {
  webBaseUrl: string | null;
  sources: BridgeSourceCatalog[];
}

/** Compact session execution & latest reply summary returned over `/v1/sessions/:source/:id/summary`. */
export interface BridgeSessionSummary {
  exists: boolean;
  state: "running" | "idle" | "unknown" | "waiting_external_approval";
  title: string | null;
  updatedAt: number | null;
  lastAssistantId: string | null;
  lastAssistantText: string | null;
  pendingApprovalsCount: number;
  activeTurnId: string | null;
  activeExecution: { executionId: string; epoch: number } | null;
  canOpenDesktop: boolean;
}

/** Operation status paired with live execution evidence. */
export interface BridgeOperationStatus {
  operation: WebOperation;
  execution: ExecutionEvidence;
}

/** Narrow an arbitrary JSON value to a plain object record. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalBridgeError(400, "invalid_body");
  }
  return value as Record<string, unknown>;
}

/** Validate a bounded string field, allowing optional null/empty values when nullable is true. */
export function readBoundedString(
  value: unknown,
  maxLength: number,
  options: { nullable?: boolean; trim?: boolean; allowEmpty?: boolean } = {},
): string | null {
  if (options.nullable && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (typeof value !== "string" || /\u0000/.test(value)) {
    throw new LocalBridgeError(400, "invalid_field");
  }
  const normalized = options.trim === false ? value : value.trim();
  if ((!options.allowEmpty && normalized.length === 0) || normalized.length > maxLength) {
    throw new LocalBridgeError(400, "invalid_field");
  }
  return normalized;
}

/** Validate an RFC 4122 UUID string used for idempotent operations. */
export function readUuid(value: unknown): string {
  const raw = readBoundedString(value, 36) ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new LocalBridgeError(400, "invalid_operation_id");
  }
  return raw;
}

/** Validate a supported native execution source identifier. */
export function readSource(value: unknown): WebOperationSource {
  if (value === "codex" || value === "antigravity" || value === "dsh") {
    return value;
  }
  throw new LocalBridgeError(400, "invalid_source");
}

/** Validate a supported client application identifier. */
export function readClientApp(value: unknown): WebClientApp {
  if (value === "toolhub" || value === "sea-bridge") {
    return value;
  }
  throw new LocalBridgeError(400, "invalid_client_app");
}

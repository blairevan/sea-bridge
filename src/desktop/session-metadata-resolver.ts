import type { CodexThread } from "./codex-thread-store.ts";
import type { ObservedSession } from "./session-state.ts";

export type ResolvedSandbox = "danger_full_access" | "workspace_write" | "read_only";
export type ResolvedApproval = "never" | "on_request";

export interface ActionSessionMetadata {
  model: string | null;
  sandbox: "danger-full-access" | "workspace-write" | "read-only" | null;
  approvalPolicy: "never" | "on-request" | null;
}

export interface ResolvedSessionMetadata {
  model?: string;
  reasoningEffort?: string;
  executionPolicy?: {
    sandbox?: ResolvedSandbox;
    approval?: ResolvedApproval;
  };
}

function bounded(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function sandbox(value: unknown): ResolvedSandbox | null {
  switch (bounded(value, 80)) {
    case "danger-full-access":
    case "dangerFullAccess":
      return "danger_full_access";
    case "workspace-write":
    case "workspaceWrite":
      return "workspace_write";
    case "read-only":
    case "readOnly":
      return "read_only";
    default:
      return null;
  }
}

function approval(value: unknown): ResolvedApproval | null {
  switch (bounded(value, 80)) {
    case "never": return "never";
    case "on-request":
    case "onRequest": return "on_request";
    default: return null;
  }
}

/**
 * Merge independent, allowlisted metadata facts without inferring missing fields.
 * Active owned-turn settings are strongest for that turn, a fresh Hook model is next,
 * and the persisted App Server/native thread snapshot provides the session fallback.
 */
export function resolveSessionMetadata(input: {
  thread: Pick<CodexThread, "model" | "reasoningEffort" | "sandboxPolicy" | "approvalMode"> | null;
  hook?: Pick<ObservedSession, "model" | "metadataObservedAt"> | null;
  action?: ActionSessionMetadata | null;
  hookFreshAfter?: number;
}): ResolvedSessionMetadata | null {
  const result: ResolvedSessionMetadata = {};
  const nativeModel = bounded(input.thread?.model);
  const rawNativeReasoning = bounded(input.thread?.reasoningEffort, 80);
  const nativeReasoning = rawNativeReasoning?.toLowerCase() === "none" ? null : rawNativeReasoning;
  const hookModel = bounded(input.hook?.model);
  const hookFresh = hookModel && input.hook
    && (input.hookFreshAfter == null || (input.hook.metadataObservedAt ?? 0) >= input.hookFreshAfter);
  const actionModel = bounded(input.action?.model);

  const model = actionModel ?? (hookFresh ? hookModel : null) ?? nativeModel;
  if (model) result.model = model;
  if (nativeReasoning) result.reasoningEffort = nativeReasoning;

  const resolvedSandbox = sandbox(input.action?.sandbox) ?? sandbox(input.thread?.sandboxPolicy);
  const resolvedApproval = approval(input.action?.approvalPolicy) ?? approval(input.thread?.approvalMode);
  if (resolvedSandbox || resolvedApproval) {
    result.executionPolicy = {
      ...(resolvedSandbox ? { sandbox: resolvedSandbox } : {}),
      ...(resolvedApproval ? { approval: resolvedApproval } : {}),
    };
  }

  return Object.keys(result).length ? result : null;
}

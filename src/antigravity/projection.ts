import type { LiveActivityItem } from "../web/codex-transcript.ts";
import type { WebHistory, WebMessage, WebSession, WebSessionMeta } from "../web/sources/types.ts";
import type { AntigravityModelCatalog } from "./model-catalog.ts";
import type { AcpSessionUpdateParams } from "./protocol.ts";
import type {
  AntigravityApprovalOption,
  AntigravityApprovalRecord,
  AntigravityMessageRecord,
  AntigravitySessionRecord,
  AntigravityStore,
} from "./store.ts";

export interface WebExecutionControl {
  activeExecutionId: string | null;
  activeEpoch: number | null;
  interrupt:
    | { status: "available"; scope: "exact_antigravity_execution" }
    | { status: "interrupting"; scope: "exact_antigravity_execution" }
    | { status: "unavailable"; reason: "execution_unknown" | "provider_unavailable" | "provider_unverified" };
}

export interface WebPendingApproval {
  id: string;
  sessionId: string;
  executionId: string;
  toolCallId: string;
  toolName: string;
  toolTitle: string;
  options: AntigravityApprovalOption[];
  createdAt: number;
  expiresAt: number;
}

export interface ReplayCollector {
  generation: number;
  newSnapshotGen: number;
  messages: AntigravityMessageRecord[];
  seqCounter: number;
  assistantMsgId: string | null;
  assistantText: string;
}

export interface ActiveTurnCollector {
  executionId: string;
  operationId: string;
  epoch: number;
  generation: number;
  accepted: boolean;
  cancelRequested: boolean;
  assistantMsgId: string;
  assistantText: string;
  seqCounter: number;
}

/** Build separated `model` and `reasoningEffort` metadata for a managed Antigravity session. */
export function buildAntigravitySessionMeta(
  session: AntigravitySessionRecord,
  catalog: AntigravityModelCatalog
): WebSessionMeta | undefined {
  const split = catalog.splitVariantId(session.modelId, session.reasoningEffort);
  if (!split.model && !split.reasoningEffort) return undefined;
  return {
    ...(split.model ? { model: split.model } : {}),
    ...(split.reasoningEffort ? { reasoningEffort: split.reasoningEffort } : {}),
  };
}

/** Map a managed Antigravity session record to `WebSession`. */
export function projectManagedWebSession(
  session: AntigravitySessionRecord,
  options: {
    catalog: AntigravityModelCatalog;
    hasPendingApproval: boolean;
    sendEnabled: boolean;
  }
): WebSession {
  const sessionMeta = buildAntigravitySessionMeta(session, options.catalog);
  let state: WebSession["state"] = "idle";
  if (options.hasPendingApproval) {
    state = "waiting_external_approval";
  } else if (session.status === "running" || session.status === "cancelling") {
    state = "running";
  } else if (session.status === "unknown") {
    state = "unknown";
  }

  const clientKind = session.clientTarget ?? (session.sessionOrigin === "desktop" ? "desktop" : "sea_bridge");

  return {
    source: "antigravity",
    id: session.sessionId,
    title: session.title || session.sessionId,
    updatedAt: session.updatedAt,
    projectId: session.projectId,
    creationClient: { kind: clientKind, evidence: "explicit" },
    ...(sessionMeta ? { sessionMeta } : {}),
    state,
    sendEnabled: options.sendEnabled && session.status !== "running" && session.status !== "cancelling",
  };
}

/** Project persisted managed messages, tool calls, pending approvals, and execution controls into `WebHistory`. */
export function projectManagedWebHistory(params: {
  session: AntigravitySessionRecord;
  records: AntigravityMessageRecord[];
  pendingApprovals: AntigravityApprovalRecord[];
  executionControl: WebExecutionControl;
  catalog: AntigravityModelCatalog;
  limit: number;
  baseMessages?: WebMessage[];
  baseActiveTurnItems?: LiveActivityItem[];
}): WebHistory & {
  executionControl: WebExecutionControl;
  pendingApprovals: WebPendingApproval[];
} {
  const { session, records, pendingApprovals, executionControl, catalog, limit, baseMessages, baseActiveTurnItems } = params;
  const visibleMessages: WebMessage[] = baseMessages ? [...baseMessages] : [];
  const activeTurnItems: LiveActivityItem[] = baseActiveTurnItems ? [...baseActiveTurnItems] : [];

  for (const rec of records) {
    if (rec.role === "tool") {
      const label = rec.toolStatus ? `${rec.text} (${rec.toolStatus})` : rec.text;
      activeTurnItems.push({ kind: "tool", text: label });
      continue;
    }
    if (rec.role === "user" || rec.role === "assistant") {
      if (baseMessages && baseMessages.length > 0) {
        const alreadyPresent = visibleMessages.some((m) => m.id === rec.id || (m.role === rec.role && m.text === rec.text));
        if (alreadyPresent) continue;
      }
      visibleMessages.push({ id: rec.id, role: rec.role, text: rec.text, createdAt: rec.createdAt });
    } else if (rec.role === "system" && rec.kind === "error") {
      visibleMessages.push({ id: rec.id, role: "error", text: rec.text, createdAt: rec.createdAt });
    }
  }

  const boundedMessages = visibleMessages.slice(-Math.max(1, Math.min(200, limit)));
  const sessionMeta = buildAntigravitySessionMeta(session, catalog);
  let sessionState: WebSession["state"] = "idle";
  if (pendingApprovals.length > 0) {
    sessionState = "waiting_external_approval";
  } else if (session.status === "running" || session.status === "cancelling") {
    sessionState = "running";
  } else if (session.status === "unknown") {
    sessionState = "unknown";
  }

  const projectedApprovals: WebPendingApproval[] = pendingApprovals.map((a) => ({
    id: a.id,
    sessionId: a.sessionId,
    executionId: a.executionId,
    toolCallId: a.toolCallId,
    toolName: a.toolName,
    toolTitle: a.toolTitle,
    options: a.options,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  }));

  return {
    messages: boundedMessages,
    cursor: null,
    completeUserHistory: session.completeHistory,
    sessionState,
    ...(sessionMeta ? { sessionMeta } : {}),
    ...(activeTurnItems.length > 0 ? { activeTurnItems: activeTurnItems.slice(-20) } : {}),
    executionControl,
    pendingApprovals: projectedApprovals,
  };
}

/** Accumulate a replayed `session/update` event during `session/load` into `ReplayCollector`. */
export function collectReplayUpdate(targetId: string, rep: ReplayCollector, update: AcpSessionUpdateParams): void {
  const u = update.update;
  const kind = u.sessionUpdate;
  const textChunk =
    u.content && typeof u.content === "object" && !Array.isArray(u.content) && typeof u.content.text === "string"
      ? u.content.text
      : "";

  if (kind === "user_message_chunk" && textChunk) {
    rep.assistantMsgId = null;
    rep.assistantText = "";
    rep.messages.push({
      id: `replay-${rep.newSnapshotGen}-${rep.seqCounter}`,
      sessionId: targetId,
      snapshotGeneration: rep.newSnapshotGen,
      seq: rep.seqCounter++,
      role: "user",
      kind,
      text: textChunk,
      toolCallId: null,
      toolName: null,
      toolStatus: null,
      replayed: true,
      createdAt: Date.now(),
    });
  } else if (kind === "agent_message_chunk" && textChunk) {
    if (!rep.assistantMsgId) {
      rep.assistantMsgId = `replay-${rep.newSnapshotGen}-${rep.seqCounter++}`;
      rep.assistantText = textChunk;
    } else {
      rep.assistantText += textChunk;
    }
    const existingIdx = rep.messages.findIndex((m) => m.id === rep.assistantMsgId);
    const msg: AntigravityMessageRecord = {
      id: rep.assistantMsgId,
      sessionId: targetId,
      snapshotGeneration: rep.newSnapshotGen,
      seq: existingIdx >= 0 ? rep.messages[existingIdx]!.seq : rep.seqCounter - 1,
      role: "assistant",
      kind,
      text: rep.assistantText,
      toolCallId: null,
      toolName: null,
      toolStatus: null,
      replayed: true,
      createdAt: Date.now(),
    };
    if (existingIdx >= 0) rep.messages[existingIdx] = msg;
    else rep.messages.push(msg);
  } else if (kind === "tool_call" && u.toolCallId) {
    rep.messages.push({
      id: `replay-tool-${rep.newSnapshotGen}-${u.toolCallId}`,
      sessionId: targetId,
      snapshotGeneration: rep.newSnapshotGen,
      seq: rep.seqCounter++,
      role: "tool",
      kind,
      text: u.title ?? u.name ?? "tool",
      toolCallId: u.toolCallId,
      toolName: u.name ?? "tool",
      toolStatus: u.status ?? null,
      replayed: true,
      createdAt: Date.now(),
    });
  }
}

/** Apply a live `session/update` notification to the store and return whether execution evidence was observed. */
export function applyLiveSessionUpdate(params: {
  targetId: string;
  session: AntigravitySessionRecord;
  turn: ActiveTurnCollector;
  update: AcpSessionUpdateParams;
  store: AntigravityStore;
}): { acceptedEvidence: boolean; updated: boolean } {
  const { targetId, session, turn, update, store } = params;
  const u = update.update;
  const kind = u.sessionUpdate;
  const textChunk =
    u.content && typeof u.content === "object" && !Array.isArray(u.content) && typeof u.content.text === "string"
      ? u.content.text
      : "";

  if (kind === "session_info_update" && typeof u.title === "string" && u.title.trim()) {
    store.upsertSession({ ...session, title: u.title.trim(), updatedAt: Date.now() });
    return { acceptedEvidence: false, updated: true };
  }

  const acceptedEvidence = kind === "agent_message_chunk" || kind === "user_message_chunk" || kind === "tool_call";

  if (kind === "agent_message_chunk" && textChunk) {
    turn.assistantText += textChunk;
    store.upsertMessage({
      id: turn.assistantMsgId,
      sessionId: targetId,
      snapshotGeneration: session.snapshotGeneration,
      seq: turn.seqCounter++,
      role: "assistant",
      kind,
      text: turn.assistantText,
      toolCallId: null,
      toolName: null,
      toolStatus: null,
      replayed: false,
      createdAt: Date.now(),
    });
    return { acceptedEvidence, updated: true };
  }

  if (kind === "tool_call" && u.toolCallId) {
    store.upsertMessage({
      id: `${turn.executionId}-tool-${u.toolCallId}`,
      sessionId: targetId,
      snapshotGeneration: session.snapshotGeneration,
      seq: turn.seqCounter++,
      role: "tool",
      kind,
      text: u.title ?? u.name ?? "tool",
      toolCallId: u.toolCallId,
      toolName: u.name ?? "tool",
      toolStatus: u.status ?? null,
      replayed: false,
      createdAt: Date.now(),
    });
    return { acceptedEvidence, updated: true };
  }

  return { acceptedEvidence, updated: false };
}

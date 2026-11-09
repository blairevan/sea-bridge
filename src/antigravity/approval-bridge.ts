import { randomUUID } from "node:crypto";
import type { AcpPermissionRequestParams, JsonRpcId } from "./protocol.ts";
import type { AntigravityApprovalRecord, AntigravityStore } from "./store.ts";

export type ApprovalOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

export type ApprovalDecisionResult =
  | { status: "decided"; approval: AntigravityApprovalRecord }
  | { status: "already_decided"; approval: AntigravityApprovalRecord }
  | { status: "expired"; approval: AntigravityApprovalRecord }
  | { status: "not_found" }
  | { status: "invalid_option" };

interface InFlightApproval {
  approvalId: string;
  sessionId: string;
  executionId: string;
  processGeneration: number;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Coordinates inbound `session/request_permission` calls from `agy acp` across Web (and future Telegram).
 * Enforces single-decision atomicity, exact `optionId` validation, and timeout auto-cancellation.
 */
export class AntigravityApprovalBridge {
  private readonly inFlight = new Map<string, InFlightApproval>();
  private readonly listeners = new Set<(sessionId: string, approval: AntigravityApprovalRecord) => void>();

  constructor(
    private readonly store: AntigravityStore,
    private readonly options: {
      timeoutMs?: number | undefined;
      onApprovalChanged?: ((sessionId: string, approval: AntigravityApprovalRecord) => void) | undefined;
      onApprovalTimeout?: ((sessionId: string, executionId: string) => void) | undefined;
    } = {}
  ) {}

  /** Register an additional listener for approval lifecycle transitions (Web + Telegram sync). */
  addListener(listener: (sessionId: string, approval: AntigravityApprovalRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChanged(sessionId: string, approval: AntigravityApprovalRecord): void {
    this.options.onApprovalChanged?.(sessionId, approval);
    for (const listener of this.listeners) {
      try {
        listener(sessionId, approval);
      } catch {
        // Listener errors must not break approval state transitions
      }
    }
  }

  /** Register an inbound `session/request_permission` request and wait for user decision or timeout/cancel. */
  requestPermission(params: {
    sessionId: string;
    executionId: string;
    processGeneration: number;
    rpcRequestId: JsonRpcId;
    request: AcpPermissionRequestParams;
    now?: number;
  }): { approval: AntigravityApprovalRecord; promise: Promise<ApprovalOutcome> } {
    const now = params.now ?? Date.now();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const approvalId = `agy-ap-${randomUUID()}`;

    const record: AntigravityApprovalRecord = {
      id: approvalId,
      sessionId: params.sessionId,
      executionId: params.executionId,
      processGeneration: params.processGeneration,
      rpcRequestId: String(params.rpcRequestId),
      toolCallId: params.request.toolCall.toolCallId,
      toolName: params.request.toolCall.name,
      toolTitle: params.request.toolCall.title ?? params.request.toolCall.name,
      options: params.request.options,
      status: "pending",
      selectedOptionId: null,
      decidedBy: null,
      createdAt: now,
      expiresAt: now + timeoutMs,
      decidedAt: null,
    };

    this.store.upsertApproval(record);
    this.notifyChanged(params.sessionId, record);

    const promise = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.expireApproval(approvalId, Date.now());
      }, timeoutMs);

      this.inFlight.set(approvalId, {
        approvalId,
        sessionId: params.sessionId,
        executionId: params.executionId,
        processGeneration: params.processGeneration,
        resolve,
        timer,
      });
    });

    return { approval: record, promise };
  }

  /** Apply a user decision (`optionId` or `"cancel"`) to a pending approval. */
  decide(params: {
    sessionId: string;
    approvalId: string;
    optionId: string;
    decidedBy: string;
    now?: number;
  }): ApprovalDecisionResult {
    const now = params.now ?? Date.now();
    const record = this.store.getApproval(params.approvalId);
    if (!record || record.sessionId !== params.sessionId) {
      return { status: "not_found" };
    }

    if (record.status !== "pending") {
      return record.status === "expired"
        ? { status: "expired", approval: record }
        : { status: "already_decided", approval: record };
    }

    if (now >= record.expiresAt) {
      const expired = this.expireApproval(record.id, now);
      return { status: "expired", approval: expired ?? record };
    }

    const active = this.inFlight.get(record.id);
    if (!active) {
      const stale: AntigravityApprovalRecord = {
        ...record,
        status: "stale",
        decidedAt: now,
      };
      this.store.upsertApproval(stale);
      return { status: "already_decided", approval: stale };
    }

    if (params.optionId === "cancel") {
      clearTimeout(active.timer);
      this.inFlight.delete(record.id);
      const updated: AntigravityApprovalRecord = {
        ...record,
        status: "cancelled",
        selectedOptionId: null,
        decidedBy: params.decidedBy,
        decidedAt: now,
      };
      this.store.upsertApproval(updated);
      active.resolve({ outcome: { outcome: "cancelled" } });
      this.notifyChanged(record.sessionId, updated);
      return { status: "decided", approval: updated };
    }

    const matchedOption = record.options.find((opt) => opt.optionId === params.optionId);
    if (!matchedOption) {
      return { status: "invalid_option" };
    }

    clearTimeout(active.timer);
    this.inFlight.delete(record.id);
    const updated: AntigravityApprovalRecord = {
      ...record,
      status: "selected",
      selectedOptionId: matchedOption.optionId,
      decidedBy: params.decidedBy,
      decidedAt: now,
    };
    this.store.upsertApproval(updated);
    active.resolve({ outcome: { outcome: "selected", optionId: matchedOption.optionId } });
    this.notifyChanged(record.sessionId, updated);
    return { status: "decided", approval: updated };
  }

  /** Settle all pending approvals for a session with `cancelled` (e.g., on user stop or worker exit). */
  cancelPendingForSession(sessionId: string, reason = "session_cancelled", now = Date.now()): number {
    let count = 0;
    for (const [approvalId, active] of this.inFlight.entries()) {
      if (active.sessionId !== sessionId) continue;
      clearTimeout(active.timer);
      this.inFlight.delete(approvalId);
      const record = this.store.getApproval(approvalId);
      if (record && record.status === "pending") {
        const updated: AntigravityApprovalRecord = {
          ...record,
          status: "cancelled",
          decidedBy: reason,
          decidedAt: now,
        };
        this.store.upsertApproval(updated);
        this.notifyChanged(sessionId, updated);
      }
      active.resolve({ outcome: { outcome: "cancelled" } });
      count++;
    }
    return count;
  }

  private expireApproval(approvalId: string, now: number): AntigravityApprovalRecord | null {
    const active = this.inFlight.get(approvalId);
    if (active) {
      clearTimeout(active.timer);
      this.inFlight.delete(approvalId);
    }
    const record = this.store.getApproval(approvalId);
    if (!record) return null;
    if (record.status !== "pending") return record;

    const updated: AntigravityApprovalRecord = {
      ...record,
      status: "expired",
      decidedBy: "timeout",
      decidedAt: now,
    };
    this.store.upsertApproval(updated);
    active?.resolve({ outcome: { outcome: "cancelled" } });
    this.notifyChanged(record.sessionId, updated);
    this.options.onApprovalTimeout?.(record.sessionId, record.executionId);
    return updated;
  }
}

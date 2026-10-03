import type { Logger } from "../logger.ts";
import type { CodexActivity } from "../web/codex-transcript.ts";
import type { QueueDeliveryDiagnostics, QueueDeliveryTrace, QueueDeliveryDetails, QueueResult } from "./codex-queue-client.ts";
import type { CodexQueueMetadata, CodexQueueMetadataSnapshot } from "./codex-queue-store.ts";
import type { CodexProcessSnapshot, QueueExecutionEvidence } from "./codex-queue-evidence.ts";

export interface QueueDiagnosticEvidence extends QueueExecutionEvidence {
  pendingApproval: boolean;
  hook: { state: string; turnId: string | null; lastEvent: string; lastSeenAt: number } | null;
}
export interface QueueDiagnosticsDependencies {
  logger: Logger; readQueue: () => CodexQueueMetadataSnapshot;
  evidence: (threadId: string, clientIds: readonly string[]) => Promise<QueueDiagnosticEvidence>;
  processes: (threadId: string) => Promise<CodexProcessSnapshot>; now?: () => number;
}
interface TrackedItem {
  item: CodexQueueMetadata; trace: QueueDeliveryTrace | null; observedInQueue: boolean;
  lastSeenAt: number; leftAt: number | null; lastWarningAt: number | null;
}
const POLL_MS = 10_000;
const WAIT_WARNING_MS = 120_000;
const WARNING_REPEAT_MS = 300_000;
const MAX_TRACKED = 1000;

/** Observe admission and native lifecycle changes without owning, starting, retrying or deleting messages. */
export class CodexQueueDiagnostics implements QueueDeliveryDiagnostics {
  private readonly tracked = new Map<string, TrackedItem>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;
  private readFailure: string | null = null;
  private stopped = false;
  private lastPollAt: number | null = null;
  private lastHeartbeatAt: number | null = null;
  private readonly now: () => number;

  /** Inject read-only observers and a deterministic clock for diagnostic regression tests. */
  constructor(private readonly deps: QueueDiagnosticsDependencies) { this.now = deps.now ?? Date.now; }

  /** Log only submission identifiers and size, never arguments, prompt text or credentials. */
  submitted(trace: QueueDeliveryTrace): void { this.deps.logger.info("codex_queue_submit_started", { ...trace }); }

  /** Keep a native receipt for later observation without changing the original delivery outcome. */
  settled(trace: QueueDeliveryTrace, result: QueueResult, details: QueueDeliveryDetails): void {
    const fields = { ...trace, ...details, ...result, queueReceiptAvailable: Boolean(result.queueItemId) };
    if (result.status === "delivered") this.deps.logger.info("codex_queue_submit_result", fields);
    else this.deps.logger.warn("codex_queue_submit_result", fields);
    if (!result.queueItemId || this.stopped) return;
    const snapshot = this.deps.readQueue();
    const native = snapshot.items.find((item) => item.id === result.queueItemId && item.threadId === trace.threadId);
    const existing = this.tracked.get(result.queueItemId);
    if (existing) { existing.trace = trace; return; }
    if (this.tracked.size >= MAX_TRACKED) { this.deps.logger.warn("codex_queue_tracking_limit", { limit: MAX_TRACKED }); return; }
    this.tracked.set(result.queueItemId, { trace, item: native ?? { id: result.queueItemId, threadId: trace.threadId,
      clientId: null, createdAt: trace.submittedAt, updatedAt: trace.submittedAt, queueOrder: 0 },
      observedInQueue: Boolean(native), lastSeenAt: this.now(), leftAt: null, lastWarningAt: null });
    this.deps.logger.info("codex_queue_receipt_observed", { ...this.fields(this.tracked.get(result.queueItemId)!),
      observedInQueue: Boolean(native), queueReadAvailable: snapshot.available, queueReadError: snapshot.errorCode ?? null });
  }

  /** Recover still-pending items after restart and emit only transitions or rate-limited warnings. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.deps.logger.info("codex_queue_diagnostics_started", { pollIntervalMs: POLL_MS, waitingWarningMs: WAIT_WARNING_MS,
      warningRepeatMs: WARNING_REPEAT_MS, servicePid: process.pid });
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
    this.timer.unref();
  }

  /** Stop scheduling and drain the bounded native read before service storage is closed. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activePoll;
  }

  /** Serialize reads; logging failures never propagate into message delivery. */
  pollOnce(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    const active = this.observeSnapshot().catch(() => {
      this.deps.logger.warn("codex_queue_diagnostics_failed", { errorCode: "diagnostic_observation_failed" });
    }).finally(() => { if (this.activePoll === active) this.activePoll = null; });
    this.activePoll = active;
    return active;
  }

  /** Construct the shared receipt/native correlation fields without exposing source content. */
  private fields(tracked: TrackedItem): Record<string, unknown> {
    return { queueItemId: tracked.item.id, threadId: tracked.item.threadId, clientMessageId: tracked.item.clientId,
      createdAt: tracked.item.createdAt, updatedAt: tracked.item.updatedAt,
      deliveryId: tracked.trace?.deliveryId ?? null, source: tracked.trace?.source ?? "native_queue",
      queueAgeMs: Math.max(0, this.now() - tracked.item.createdAt) };
  }

  /** Summarize the latest session evidence separately from exact queued-input/turn correlation. */
  private activityFields(activity: CodexActivity | null): Record<string, unknown> {
    return { latestState: activity?.state ?? "unknown", latestTurnId: activity?.turnId ?? null,
      latestObservedAt: activity?.observedAt ?? null };
  }

  /** Distinguish unavailable/partial reads from disappearance, preserving tracked input on uncertainty. */
  private async observeSnapshot(): Promise<void> {
    const snapshot = this.deps.readQueue();
    const previousPollAt = this.lastPollAt;
    this.lastPollAt = this.now();
    if (previousPollAt !== null && this.now() - previousPollAt > POLL_MS * 3) {
      this.deps.logger.warn("codex_queue_observation_gap", { previousPollAt, pollGapMs: this.now() - previousPollAt,
        servicePid: process.pid, clockChangePossible: true });
    }
    if (this.lastHeartbeatAt === null || this.now() - this.lastHeartbeatAt >= WARNING_REPEAT_MS) {
      this.lastHeartbeatAt = this.now();
      this.deps.logger.info("codex_queue_observer_health", { queueReadAvailable: snapshot.available,
        pendingCount: snapshot.available ? snapshot.items.length : null, snapshotTruncated: snapshot.truncated,
        trackedCount: this.tracked.size, servicePid: process.pid });
    }
    if (!snapshot.available) {
      const code = snapshot.errorCode ?? "queue_read_failed";
      if (this.readFailure !== code) this.deps.logger.warn("codex_queue_read_unavailable", { errorCode: code, trackedCount: this.tracked.size });
      this.readFailure = code; return;
    }
    if (this.readFailure) this.deps.logger.info("codex_queue_read_recovered", { previousErrorCode: this.readFailure });
    this.readFailure = null;
    const seen = new Set(snapshot.items.map((item) => item.id));
    for (const item of snapshot.items) {
      const old = this.tracked.get(item.id);
      if (old) {
        if (old.item.updatedAt !== item.updatedAt || old.item.queueOrder !== item.queueOrder) {
          this.deps.logger.info("codex_queue_item_changed", { ...this.fields(old), newUpdatedAt: item.updatedAt, newQueueOrder: item.queueOrder });
        }
        old.item = item; old.observedInQueue = true; old.lastSeenAt = this.now(); old.leftAt = null;
      } else if (this.tracked.size < MAX_TRACKED) {
        const tracked: TrackedItem = { item, trace: null, observedInQueue: true, lastSeenAt: this.now(), leftAt: null, lastWarningAt: null };
        this.tracked.set(item.id, tracked); this.deps.logger.info("codex_queue_item_seen", this.fields(tracked));
      }
    }
    // A truncated scan cannot prove absence, even if an item's previous order changed.
    if (!snapshot.truncated) for (const tracked of this.tracked.values()) {
      if (seen.has(tracked.item.id) || tracked.leftAt !== null) continue;
      tracked.leftAt = this.now();
      this.deps.logger.info("codex_queue_item_left", { ...this.fields(tracked), lastSeenAt: tracked.lastSeenAt,
        removalObservedAt: tracked.leftAt, previouslyObservedInQueue: tracked.observedInQueue, executionConfirmed: false });
    }
    const evidence = new Map<string, Promise<QueueDiagnosticEvidence>>();
    for (const tracked of this.tracked.values()) {
      const age = this.now() - tracked.item.createdAt;
      const warnDue = age >= WAIT_WARNING_MS && (tracked.lastWarningAt === null || this.now() - tracked.lastWarningAt >= WARNING_REPEAT_MS);
      if (tracked.leftAt === null && !warnDue) continue;
      let reading = evidence.get(tracked.item.threadId);
      if (!reading) {
        const ids = [...this.tracked.values()].filter((entry) => entry.item.threadId === tracked.item.threadId)
          .flatMap((entry) => entry.item.clientId ? [entry.item.clientId] : []);
        reading = this.deps.evidence(tracked.item.threadId, ids); evidence.set(tracked.item.threadId, reading);
      }
      const observed = await reading;
      if (tracked.leftAt !== null) { this.observeRemoved(tracked, observed); continue; }
      tracked.lastWarningAt = this.now();
      const sameThread = snapshot.items.filter((item) => item.threadId === tracked.item.threadId);
      this.deps.logger.warn("codex_queue_waiting_long", { ...this.fields(tracked), ...this.activityFields(observed.activity),
        queuePosition: sameThread.findIndex((item) => item.id === tracked.item.id) + 1, queueDepth: sameThread.length,
        snapshotTruncated: snapshot.truncated, executionEvidenceAvailable: observed.available,
        pendingApproval: observed.pendingApproval, hook: observed.hook, ...await this.deps.processes(tracked.item.threadId), nativeLockState: "unobserved" });
    }
  }

  /** Only a native UserMessage.client_id match proves which turn accepted a removed queued input. */
  private observeRemoved(tracked: TrackedItem, observed: QueueDiagnosticEvidence): void {
    const match = tracked.item.clientId ? observed.matches.get(tracked.item.clientId) : null;
    if (match) {
      this.deps.logger.info("codex_queue_execution_observed", { ...this.fields(tracked), ...match, exactClientMatch: true });
      this.tracked.delete(tracked.item.id); return;
    }
    if (tracked.leftAt !== null && this.now() - tracked.leftAt >= WAIT_WARNING_MS) {
      this.deps.logger.warn("codex_queue_execution_unconfirmed", { ...this.fields(tracked), ...this.activityFields(observed.activity),
        executionEvidenceAvailable: observed.available, removalObservedAt: tracked.leftAt, exactClientMatch: false });
      this.tracked.delete(tracked.item.id);
    }
  }
}

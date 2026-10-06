import type { Logger } from "../logger.ts";
import type { CodexQueueMetadataSnapshot } from "./codex-queue-store.ts";

/** A launch receipt or failure, never a claim that queued work has begun executing. */
export interface CodexQueueRecoveryNotice {
  threadId: string;
  outcome: "open_requested" | "failed";
  occurredAt: number;
}

/** Native observations and the existing guarded Desktop activation entry point. */
export interface CodexQueueRecoveryDependencies {
  logger: Logger;
  readQueue: () => CodexQueueMetadataSnapshot;
  isIdle: (threadId: string) => Promise<boolean>;
  openDesktop: (threadId: string) => Promise<void>;
  onRecovery?: (notice: CodexQueueRecoveryNotice) => void;
  now?: () => number;
}

/** Recover idle native queues without re-sending input or taking execution ownership. */
export class CodexQueueRecovery {
  private readonly attempted = new Set<string>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;
  private stopped = false;
  private lastAttemptAt: number | null = null;

  /** Inject a clock and read-only state providers for deterministic recovery tests. */
  constructor(private readonly deps: CodexQueueRecoveryDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /** Monitor on the server even when no mobile browser is connected. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.deps.logger.info("codex_queue_recovery_started", { pollIntervalMs: 1000, queueWaitMs: 10_000 });
    this.timer = setInterval(() => void this.pollOnce(), 1000);
    this.timer.unref();
    void this.pollOnce();
  }

  /** Cancel scheduled checks and await outstanding evidence or activation before shutdown. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activePoll;
  }

  /** Serialize polls and contain observation failures without disrupting the bridge. */
  pollOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activePoll) return this.activePoll;
    this.activePoll = this.observe().catch(() => {
      this.deps.logger.warn("codex_queue_recovery_observation_failed");
    }).finally(() => { this.activePoll = null; });
    return this.activePoll;
  }

  /** Keep browser notification errors separate from the actual Desktop activation result. */
  private notify(threadId: string, outcome: CodexQueueRecoveryNotice["outcome"]): void {
    try { this.deps.onRecovery?.({ threadId, outcome, occurredAt: this.now() }); }
    catch { this.deps.logger.warn("codex_queue_recovery_notice_failed", { threadId }); }
  }

  /** Require complete queue evidence and re-check eligibility immediately before one activation. */
  private async observe(): Promise<void> {
    const snapshot = this.deps.readQueue();
    if (!snapshot.available || snapshot.truncated) return;
    const present = new Set(snapshot.items.map((item) => item.id));
    for (const id of this.attempted) if (!present.has(id)) this.attempted.delete(id);
    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < 5000) return;
    const seenThreads = new Set<string>();
    for (const item of snapshot.items) {
      if (this.stopped) return;
      if (seenThreads.has(item.threadId)) continue;
      seenThreads.add(item.threadId);
      if (this.attempted.has(item.id) || this.now() - item.createdAt <= 10_000) continue;
      try {
        if (!await this.deps.isIdle(item.threadId) || this.stopped) continue;
        if (!await this.deps.isIdle(item.threadId) || this.stopped) continue;
        const current = this.deps.readQueue();
        if (!current.available || current.truncated || !current.items.some((pending) =>
          pending.id === item.id && pending.threadId === item.threadId && this.now() - pending.createdAt > 10_000)) continue;
        for (const pending of current.items) {
          if (pending.threadId === item.threadId) this.attempted.add(pending.id);
        }
        this.lastAttemptAt = this.now();
        this.deps.logger.info("codex_queue_recovery_requested", { threadId: item.threadId, queueWaitMs: this.now() - item.createdAt });
        try {
          await this.deps.openDesktop(item.threadId);
          this.deps.logger.info("codex_queue_recovery_open_requested", { threadId: item.threadId });
          this.notify(item.threadId, "open_requested");
        } catch {
          this.deps.logger.warn("codex_queue_recovery_failed", { threadId: item.threadId });
          this.notify(item.threadId, "failed");
        }
        return;
      } catch {
        this.deps.logger.warn("codex_queue_recovery_evidence_unavailable", { threadId: item.threadId });
      }
    }
  }
}

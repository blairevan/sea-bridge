import { stat } from "node:fs/promises";
import type { CodexThread } from "../desktop/codex-thread-store.ts";
import type { CodexReadTurn } from "../desktop/codex-read-service.ts";
import { readCodexActivity, type CodexActivity } from "./codex-transcript.ts";
import type { WebSession, StateConfirmation } from "./sources/types.ts";

export interface ObservedActivity {
  state: "active" | "idle" | "unknown";
  turnId: string | null;
}

export interface SessionActivity {
  state: WebSession["state"];
  activity: CodexActivity | null;
  stateConfirmation?: StateConfirmation;
}

interface CachedActivity {
  signature: string;
  native: CodexActivity | null;
  checkedAt: number;
  uncertainSince: number | null;
  lastKnownState?: "running" | "idle";
  lastKnownTurn?: string | null;
}

/** Shared display evidence; never grants execution, model-update or interrupt permissions. */
export class SessionActivityResolver {
  private readonly files = new Map<string, CachedActivity>();
  private readonly reads = new Map<string, Promise<SessionActivity>>();
  private revision = 0;
  private readonly turns = new Map<string, { key: string; at: number; revision: number; turn: CodexReadTurn | null }>();
  private readonly pendingTurns = new Map<string, { key: string; read: Promise<CodexReadTurn | null> }>();

  /** Keep runtime probes optional for existing adapters, with a clock for deterministic expiry checks. */
  constructor(
    private readonly roots: readonly string[],
    private readonly readLatestTurn?: (id: string) => Promise<CodexReadTurn | null>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Coalesce list/detail reads so an older asynchronous refresh cannot overwrite a newer one. */
  async resolve(thread: CodexThread, observed: ObservedActivity | null): Promise<SessionActivity> {
    const pending = this.reads.get(thread.id);
    if (pending) {
      await pending;
      return this.resolve(thread, observed);
    }
    const read = this.refresh(thread, observed);
    this.reads.set(thread.id, read);
    try { return await read; }
    finally { if (this.reads.get(thread.id) === read) this.reads.delete(thread.id); }
  }

  /** Parse only changed rollouts; failed reads retain the last confirmed display evidence. */
  private async native(thread: CodexThread): Promise<{ cache: CachedActivity; failed: boolean }> {
    let cache = this.files.get(thread.id);
    try {
      if (!thread.rolloutPath) throw new Error("rollout_missing");
      const info = await stat(thread.rolloutPath);
      const signature = `${thread.rolloutPath}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (!cache || cache.signature !== signature) {
        const native = await readCodexActivity(thread.rolloutPath, this.roots);
        const sameTurn = native?.turnId === cache?.native?.turnId;
        cache = { ...cache, signature, native, checkedAt: this.now(), uncertainSince: sameTurn ? cache?.uncertainSince ?? null : null };
      }
      this.remember(thread.id, cache);
      return { cache, failed: false };
    } catch {
      cache ??= { signature: "", native: null, checkedAt: this.now(), uncertainSince: null };
      this.remember(thread.id, cache);
      return { cache, failed: true };
    }
  }

  /** Bound memory independently of the number of archived or searched threads. */
  private remember(id: string, cache: CachedActivity): void {
    this.files.delete(id);
    this.files.set(id, cache);
    if (this.files.size > 200) {
      const oldest = this.files.keys().next().value;
      if (oldest) { this.files.delete(oldest); this.turns.delete(oldest); }
    }
  }

  /** Limit remote load and wait time; timed-out probes stay coalesced until the transport finishes. */
  private async latest(id: string, key: string): Promise<CodexReadTurn | null> {
    const cached = this.turns.get(id);
    if (cached?.key === key && this.now() - cached.at < 10_000) return cached.turn;
    if (!this.readLatestTurn) return null;
    const probeKey = `${id}:${key}`;
    let pending = this.pendingTurns.get(probeKey);
    if (!pending) {
      if (this.pendingTurns.size >= 4) return null;
      const revision = ++this.revision;
      const read = this.readLatestTurn(id).catch(() => null).then((turn) => {
        if (this.files.has(id) && (this.turns.get(id)?.revision ?? 0) < revision) this.turns.set(id, { key, at: this.now(), revision, turn });
        return turn;
      }).finally(() => { this.pendingTurns.delete(probeKey); });
      pending = { key, read };
      this.pendingTurns.set(probeKey, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A query begun for an older file/catalog snapshot cannot resolve the current snapshot.
      if (pending.key !== key) return null;
      return await Promise.race([pending.read, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 800); })]);
    }
    finally { if (timer) clearTimeout(timer); }
  }

  /** Resolve only matching/latest turn facts, retaining ambiguity rather than manufacturing a terminal state. */
  private async refresh(thread: CodexThread, observed: ObservedActivity | null): Promise<SessionActivity> {
    const { cache, failed } = await this.native(thread);
    const native = failed ? null : cache.native;
    const differentTurn = Boolean(observed?.turnId && native && observed.turnId !== native.turnId);
    const newerSnapshot = native?.state === "idle" && thread.updatedAtMs > native.observedAt;
    const progressAge = native?.lastActivityAt === undefined ? Infinity : this.now() - native.lastActivityAt;
    const freshExecution = native?.state === "active" && native.lastActivityAt !== undefined
      && native.lastActivityAt > native.observedAt && progressAge >= -5000 && progressAge <= 120_000 && !differentTurn;
    let activity: CodexActivity | null = null;
    let reason: StateConfirmation["reason"] = failed ? "read_unavailable" : "missing_evidence";
    if (freshExecution) activity = native;
    else if (native?.state === "idle" && !differentTurn && !newerSnapshot) activity = native;
    else if (observed?.state !== "unknown" && observed?.turnId && !differentTurn && !newerSnapshot) {
      // A terminal local record takes precedence over a lagging active observer for the same turn.
      activity = { state: observed.state, turnId: observed.turnId, observedAt: native?.observedAt ?? thread.updatedAtMs };
    } else if (native?.state === "active" && !this.readLatestTurn && !differentTurn) {
      activity = native;
    }
    if (!activity || differentTurn) {
      const key = `${cache.signature}:${thread.updatedAtMs}:${observed?.turnId}:${observed?.state}`;
      const turn = await this.latest(thread.id, key);
      const matchesObserver = !observed?.turnId || turn?.id === observed.turnId || native?.turnId === observed.turnId;
      if (turn && matchesObserver && (!native || turn.id === native.turnId || (turn.startedAtMs !== null && turn.startedAtMs > native.observedAt))) {
        const terminal = turn.status === "completed" || turn.status === "failed"
          || (turn.status === "interrupted" && turn.completedAtMs !== null);
        if (native?.turnId === turn.id && native.state === "idle") activity = native;
        else if (terminal || turn.status === "inProgress") {
          activity = { state: terminal ? "idle" : "active", turnId: turn.id, observedAt: (terminal ? turn.completedAtMs : turn.startedAtMs) ?? thread.updatedAtMs };
        } else reason = "conflicting_evidence";
      } else if (differentTurn || observed?.state === "unknown") reason = "conflicting_evidence";
    }
    if (activity) {
      cache.uncertainSince = null;
      cache.lastKnownState = activity.state === "active" ? "running" : "idle";
      cache.lastKnownTurn = activity.turnId;
      return { state: cache.lastKnownState, activity: native?.turnId === activity.turnId && native.state === activity.state ? native : activity };
    }
    cache.uncertainSince ??= this.now();
    const sameTurn = (!observed?.turnId || observed.turnId === cache.lastKnownTurn)
      && (!native || native.turnId === cache.lastKnownTurn);
    return { state: "unknown", activity: null, stateConfirmation: {
      phase: this.now() - cache.uncertainSince < 30_000 ? "checking" : "unavailable", reason,
      ...(sameTurn && cache.lastKnownState ? { lastKnownState: cache.lastKnownState } : {}),
    } };
  }
}

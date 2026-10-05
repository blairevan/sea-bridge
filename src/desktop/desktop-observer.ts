import type { Logger } from "../logger.ts";
import { redact } from "../security/redact.ts";
import type { DesktopMessageEventKind, DesktopMessageStore } from "../state/desktop-message-store.ts";
import {
  CodexObserverStore,
  textHash,
  type CodexObserverThreadState,
  type ObservationCommit,
} from "../state/codex-observer-store.ts";
import type { InlineButton, TelegramClient } from "../telegram/client.ts";
import type { CodexCatalogStore } from "./codex-catalog-store.ts";
import type { CodexReadService, CodexReadThread, CodexReadTurn } from "./codex-read-service.ts";

const TELEGRAM_SAFE_MESSAGE_LENGTH = 4_000;
const TITLE_SAFE_LENGTH = 900;
const DEFAULT_FULL_CATALOG_INTERVAL_MS = 60_000;
const DEFAULT_COLD_RECONCILE_MS = 5 * 60_000;
const DEFAULT_SETTLE_MS = 10_000;
const DEFAULT_BASELINE_BATCH = 10;
const DEFAULT_REFRESH_BATCH = 20;
const OVERLAP_TURNS = 2;
const POLL_FAILURE_LOG_INTERVAL_MS = 60_000;

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^[A-Za-z0-9_]+/.exec(raw);
  return (match?.[0] ?? (error instanceof Error ? error.name : "unknown_error")).slice(0, 120);
}

export interface DesktopObserverHealth {
  history: "initializing" | "ready" | "degraded" | "unavailable" | "reinitialize_required";
  notifications: "initializing" | "ready" | "degraded" | "unavailable" | "reinitialize_required";
  deferredThreads: number;
}

interface RuntimeTurnEvidence {
  state: "active" | "idle" | "unknown";
  turnId: string | null;
  lastEvent: string;
}

interface DesktopObserverOptions {
  fullCatalogIntervalMs?: number;
  coldReconcileMs?: number;
  settleMs?: number;
  baselineBatch?: number;
  refreshBatch?: number;
  now?: () => number;
  runtimeEvidence?: (threadId: string) => RuntimeTurnEvidence | null;
}

function terminalKind(status: CodexReadTurn["status"]): "completed" | "failed" | "interrupted" | null {
  return status === "completed" || status === "failed" || status === "interrupted" ? status : null;
}

function summary(value: string | null, maxChars: number): string | null {
  if (!value) return null;
  const redacted = redact(value);
  const text = typeof redacted === "string" ? redacted : "";
  if (!text) return null;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n内容已截断`;
}

/** Build the same bounded Telegram terminal notification as the legacy observer. */
function notificationText(
  thread: { title: string },
  kind: "completed" | "failed" | "interrupted",
  finalText: string | null,
  maxChars: number,
): string {
  const labels: Record<DesktopMessageEventKind, string> = {
    started: "开始执行",
    waiting_for_input: "等待输入",
    completed: "执行完成",
    failed: "执行失败",
    interrupted: "已中断",
    reply_prompt: "等待回复",
    thread_created: "已创建",
  };
  const title = thread.title.length <= TITLE_SAFE_LENGTH
    ? thread.title
    : `${thread.title.slice(0, TITLE_SAFE_LENGTH - 8)}…[标题已截断]`;
  const header = `Codex: ${title}\n状态: ${labels[kind]}`;
  const body = summary(finalText, maxChars);
  if (!body) return header;
  const bodyBudget = TELEGRAM_SAFE_MESSAGE_LENGTH - header.length - 1;
  if (body.length <= bodyBudget) return `${header}\n${body}`;
  const suffix = "\n[内容已截断]";
  const truncatedBody = body.slice(0, Math.max(0, bodyBudget - suffix.length));
  return `${header}\n${truncatedBody}${suffix}`;
}

/** App-server based catalog/history observer. Legacy ordinal cursors are intentionally unused. */
export class DesktopObserver {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deliveryTimer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;
  private activeDelivery: Promise<void> | null = null;
  private lastFullCatalogAt = 0;
  private stopped = false;
  private pollFailureKey: string | null = null;
  private pollFailureCount = 0;
  private pollFailureSince = 0;
  private pollFailureLastLoggedAt = 0;
  private _health: DesktopObserverHealth = { history: "initializing", notifications: "initializing", deferredThreads: 0 };
  private readonly fullCatalogIntervalMs: number;
  private readonly coldReconcileMs: number;
  private readonly settleMs: number;
  private readonly baselineBatch: number;
  private readonly refreshBatch: number;
  private readonly now: () => number;
  private readonly runtimeEvidence: (threadId: string) => RuntimeTurnEvidence | null;

  constructor(
    private readonly read: CodexReadService,
    private readonly catalog: CodexCatalogStore,
    private readonly observerState: CodexObserverStore,
    private readonly messages: DesktopMessageStore,
    private readonly telegram: Pick<TelegramClient, "sendMessage">,
    private readonly chatId: string,
    private readonly logger: Logger,
    private readonly pollIntervalMs: number,
    private readonly summaryMaxChars: number,
    options: DesktopObserverOptions = {},
  ) {
    this.fullCatalogIntervalMs = options.fullCatalogIntervalMs ?? DEFAULT_FULL_CATALOG_INTERVAL_MS;
    this.coldReconcileMs = options.coldReconcileMs ?? DEFAULT_COLD_RECONCILE_MS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.baselineBatch = options.baselineBatch ?? DEFAULT_BASELINE_BATCH;
    this.refreshBatch = options.refreshBatch ?? DEFAULT_REFRESH_BATCH;
    this.now = options.now ?? Date.now;
    this.runtimeEvidence = options.runtimeEvidence ?? (() => null);
  }

  get health(): DesktopObserverHealth {
    return this._health;
  }

  start(): void {
    if (this.pollTimer || this.deliveryTimer) return;
    this.stopped = false;
    void this.runScheduledPoll();
    void this.runDelivery();
    this.pollTimer = setInterval(() => void this.runScheduledPoll(), this.pollIntervalMs);
    this.deliveryTimer = setInterval(() => void this.runDelivery(), Math.min(this.pollIntervalMs, 2_000));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    this.pollTimer = null;
    this.deliveryTimer = null;
    await Promise.all([
      this.activePoll?.catch(() => undefined),
      this.activeDelivery?.catch(() => undefined),
    ]);
  }

  async pollOnce(): Promise<void> {
    const environment = this.observerState.ensureEnvironment(this.now());
    if (environment === "reinitialize_required") {
      this._health = { history: "reinitialize_required", notifications: "reinitialize_required", deferredThreads: 0 };
      return;
    }
    if (this.read.state === "protocol_incompatible") {
      this._health = { history: "unavailable", notifications: "unavailable", deferredThreads: this.observerState.deferredCount() };
      return;
    }

    this.observerState.beginBootstrap(this.now());
    const meta = this.observerState.getMeta();
    if (!meta) throw new Error("codex_observer_meta_missing");

    let hotThreads: CodexReadThread[] = [];
    if (meta.bootstrapCatalogGeneration == null) {
      const full = await this.read.listThreads();
      const generation = this.catalog.commitFull(full, this.now());
      this.observerState.freezeInitialCatalog(full.map((thread) => thread.id), generation, this.now());
      this.lastFullCatalogAt = this.now();
      hotThreads = full.slice(0, 100);
    } else {
      const hot = await this.read.listThreadPage(null);
      hotThreads = hot.data;
      this.catalog.mergeHot(hotThreads, this.now());
      for (const thread of hotThreads) this.observerState.ensureDiscoveredThread(thread.id, thread.recencyAtMs, this.now());
      if (this.now() - this.lastFullCatalogAt >= this.fullCatalogIntervalMs) {
        const full = await this.read.listThreads();
        this.catalog.commitFull(full, this.now());
        for (const thread of full) this.observerState.ensureDiscoveredThread(thread.id, thread.recencyAtMs, this.now());
        this.lastFullCatalogAt = this.now();
      }
    }

    for (const state of this.observerState.listInitialPending(this.baselineBatch)) {
      await this.baselineThread(state);
    }

    const candidates = new Map<string, CodexObserverThreadState>();
    const reserve = Math.max(1, Math.ceil(this.refreshBatch / 4));
    const urgentDue = this.observerState.listUrgentDue(this.now(), this.refreshBatch);
    const coldDue = this.observerState.listColdDue(this.now(), this.refreshBatch);
    const changedHot = this.observerState.listChangedHot(hotThreads, this.now());
    const add = (states: readonly CodexObserverThreadState[], maxNew: number): void => {
      let added = 0;
      for (const state of states) {
        if (candidates.size >= this.refreshBatch || added >= maxNew) break;
        if (candidates.has(state.threadId)) continue;
        candidates.set(state.threadId, state);
        added += 1;
      }
    };

    const coldQuota = coldDue.length > 0 ? Math.min(reserve, this.refreshBatch) : 0;
    const hotQuota = changedHot.length > 0 ? Math.min(reserve, this.refreshBatch - coldQuota) : 0;
    add(urgentDue, Math.max(0, this.refreshBatch - coldQuota - hotQuota));
    add(coldDue, coldQuota);
    add(changedHot, hotQuota);
    add(urgentDue, this.refreshBatch);
    add(coldDue, this.refreshBatch);
    add(changedHot, this.refreshBatch);
    if (candidates.size < this.refreshBatch) add(this.observerState.listDue(this.now(), this.refreshBatch), this.refreshBatch);

    let processed = 0;
    for (const state of candidates.values()) {
      if (processed >= this.refreshBatch) break;
      if (state.baselineState === "pending" || (state.baselineState === "deferred" && state.monitoringStartedAt == null)) {
        await this.baselineThread(state);
      } else {
        await this.refreshThread(state);
      }
      processed += 1;
    }

    this.observerState.completeInitialPass(this.now());
    this.updateHealth();
  }

  private async runScheduledPoll(): Promise<void> {
    if (this.activePoll || this.stopped) return;
    const task = this.pollOnce();
    this.activePoll = task;
    try {
      await task;
      if (this.read.state !== "protocol_incompatible") this.recordPollRecovery();
    } catch (error) {
      const deferredThreads = this.observerState.deferredCount();
      const initializing = this.observerState.getMeta()?.bootstrapInitialPassCompletedAt == null;
      this._health = {
        history: initializing ? "initializing" : deferredThreads > 0 ? "degraded" : "unavailable",
        notifications: initializing ? "initializing" : deferredThreads > 0 ? "degraded" : "unavailable",
        deferredThreads,
      };
      this.recordPollFailure(error);
    } finally {
      if (this.activePoll === task) this.activePoll = null;
    }
  }

  private async baselineThread(state: CodexObserverThreadState): Promise<void> {
    const thread = this.catalog.getThread(state.threadId) ?? { title: `未命名会话 · ${state.threadId.slice(-8)}` };
    try {
      const turns = await this.read.listTurns(state.threadId, "desc");
      const observations = await this.buildObservations(thread, state, turns, state.bootstrapMember && state.monitoringStartedAt == null);
      this.observerState.commitThreadRefresh({
        threadId: state.threadId,
        observations,
        anchorTurnId: turns[0]?.id ?? null,
        baselineState: "monitoring",
        monitoringStartedAt: this.now(),
        nextHistoryReconcileAt: this.nextReconcile(observations),
        lastReconciledAt: this.now(),
        lastRecencyAtMs: this.currentRecency(state.threadId),
      }, this.now());
      this.logger.info("codex_thread_baselined", { threadId: state.threadId, turnCount: turns.length });
    } catch (error) {
      const code = errorCode(error);
      const shouldLog = state.lastError !== code;
      this.observerState.markDeferred(state.threadId, code, this.now() + 10_000, this.now());
      if (shouldLog) this.logger.warn("codex_thread_baseline_failed", { threadId: state.threadId, errorCode: code });
    }
  }

  private async refreshThread(state: CodexObserverThreadState): Promise<void> {
    const thread = this.catalog.getThread(state.threadId);
    const displayThread = thread ?? { title: `未命名会话 · ${state.threadId.slice(-8)}` };
    try {
      const turns = await this.scanToAnchor(state);
      const observations = await this.buildObservations(displayThread, state, turns, false);
      this.observerState.commitThreadRefresh({
        threadId: state.threadId,
        observations,
        anchorTurnId: turns[0]?.id ?? state.anchorTurnId,
        baselineState: "monitoring",
        monitoringStartedAt: state.monitoringStartedAt ?? this.now(),
        nextHistoryReconcileAt: this.nextReconcile(observations),
        lastReconciledAt: this.now(),
        lastRecencyAtMs: this.currentRecency(state.threadId),
      }, this.now());
    } catch (error) {
      const code = errorCode(error);
      const shouldLog = state.lastError !== code;
      this.observerState.markDeferred(state.threadId, code, this.now() + 10_000, this.now());
      if (shouldLog) this.logger.warn("codex_thread_refresh_failed", { threadId: state.threadId, errorCode: code });
    }
  }

  private async scanToAnchor(state: CodexObserverThreadState): Promise<CodexReadTurn[]> {
    if (!state.anchorTurnId) return this.read.listTurns(state.threadId, "desc");
    const pending = new Set(this.observerState.pendingTurnIds(state.threadId));
    const foundPending = new Set<string>();
    const turns: CodexReadTurn[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let foundAnchor = false;
    let overlap = 0;

    for (let page = 0; page < 100; page++) {
      const current = await this.read.listTurnPage(state.threadId, cursor, "desc");
      for (const turn of current.data) {
        turns.push(turn);
        if (pending.has(turn.id)) foundPending.add(turn.id);
        if (turn.id === state.anchorTurnId) {
          foundAnchor = true;
          continue;
        }
        if (foundAnchor) overlap += 1;
      }
      const allPendingFound = [...pending].every((id) => foundPending.has(id));
      if (foundAnchor && overlap >= OVERLAP_TURNS && allPendingFound) return turns;
      if (!current.nextCursor) {
        if (!foundAnchor) throw new Error("codex_history_anchor_not_found");
        if (!allPendingFound) throw new Error("codex_history_pending_turn_not_found");
        return turns;
      }
      if (cursors.has(current.nextCursor)) throw new Error("codex_turn_list_cursor_loop");
      cursors.add(current.nextCursor);
      cursor = current.nextCursor;
    }
    throw new Error("codex_turn_list_page_limit");
  }

  private async buildObservations(
    thread: { title: string },
    state: CodexObserverThreadState,
    turns: readonly CodexReadTurn[],
    initialBootstrapSnapshot: boolean,
  ): Promise<ObservationCommit[]> {
    const observations: ObservationCommit[] = [];
    const boundarySecond = Math.floor(state.monitorFromAt / 1000) * 1000;
    for (const turn of turns) {
      const previous = this.observerState.getObservation(state.threadId, turn.id);
      const kind = terminalKind(turn.status);
      if (!kind) {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: null,
          contentState: "not_applicable",
          disposition: "monitoring",
        });
        continue;
      }

      const identityKinds = this.observerState.terminalIdentityKinds(state.threadId, turn.id);
      const correctionFromInterrupted = kind === "completed"
        && identityKinds.size === 1
        && identityKinds.has("interrupted");
      const upgradingInterruptedObservation = kind === "completed" && previous?.terminalKind === "interrupted";
      if (previous?.terminalKind && previous.terminalKind !== kind && !upgradingInterruptedObservation) {
        this.logger.warn("codex_turn_terminal_status_conflict", {
          threadId: state.threadId,
          turnId: turn.id,
          first: previous.terminalKind,
          observed: kind,
        });
        continue;
      }
      if (identityKinds.has(kind)) {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: kind,
          contentState: previous?.contentState ?? "not_applicable",
          disposition: "already_known",
          replaceTerminalKind: upgradingInterruptedObservation,
        });
        continue;
      }
      if (identityKinds.size > 0 && !correctionFromInterrupted) {
        this.logger.warn("codex_turn_terminal_identity_conflict", {
          threadId: state.threadId,
          turnId: turn.id,
          observed: kind,
          existing: [...identityKinds].sort().join(","),
        });
        continue;
      }

      const runtime = this.runtimeEvidence(state.threadId);
      const exactActive = runtime?.state === "active" && runtime.turnId === turn.id;
      const exactInterrupt = runtime?.state === "idle" && runtime.turnId === turn.id && runtime.lastEvent === "Interrupt";
      const isHistorical = (turn.completedAtMs != null && turn.completedAtMs < boundarySecond)
        || (initialBootstrapSnapshot && previous == null && turn.completedAtMs == null && !exactActive);
      if (isHistorical) {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: kind,
          contentState: "not_applicable",
          disposition: "baseline_suppressed",
          terminalFirstObservedAt: this.now(),
        });
        continue;
      }

      const terminalFirstObservedAt = previous?.terminalFirstObservedAt ?? this.now();
      const settleDeadlineAt = previous?.settleDeadlineAt ?? (terminalFirstObservedAt + this.settleMs);
      let finalText: string | null = null;
      let readFailed = false;
      try {
        finalText = await this.read.finalText(state.threadId, turn.id);
      } catch {
        readFailed = true;
      }

      if (kind === "interrupted" && turn.completedAtMs == null && !finalText && !exactInterrupt) {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: null,
          contentState: "pending",
          disposition: "monitoring",
          terminalFirstObservedAt,
          settleDeadlineAt,
        });
        continue;
      }

      const completedEvidence = kind !== "completed" || turn.completedAtMs != null || Boolean(finalText);
      const recoveringInterrupted = upgradingInterruptedObservation || correctionFromInterrupted;
      const replaceTerminalKind = recoveringInterrupted && completedEvidence;
      if (recoveringInterrupted && !completedEvidence) {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: null,
          contentState: "pending",
          disposition: "monitoring",
          terminalFirstObservedAt,
          settleDeadlineAt,
        });
        continue;
      }

      if (finalText) {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: kind,
          contentState: "ready",
          disposition: "monitoring",
          finalTextHash: textHash(finalText),
          terminalFirstObservedAt,
          settleDeadlineAt,
          replaceTerminalKind,
          notification: {
            chatId: this.chatId,
            eventKind: kind,
            text: notificationText(thread, kind, finalText, this.summaryMaxChars),
            correctionFromInterrupted,
          },
        });
        continue;
      }

      if (kind !== "completed") {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: kind,
          contentState: readFailed ? "timeout_unconfirmed" : "confirmed_empty",
          disposition: "monitoring",
          terminalFirstObservedAt,
          settleDeadlineAt,
          notification: {
            chatId: this.chatId,
            eventKind: kind,
            text: notificationText(thread, kind, null, this.summaryMaxChars),
          },
        });
        continue;
      }

      if (this.now() >= settleDeadlineAt) {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: kind,
          contentState: readFailed ? "timeout_unconfirmed" : "confirmed_empty",
          disposition: "monitoring",
          terminalFirstObservedAt,
          settleDeadlineAt,
          replaceTerminalKind,
          notification: {
            chatId: this.chatId,
            eventKind: kind,
            text: notificationText(thread, kind, null, this.summaryMaxChars),
            correctionFromInterrupted,
          },
        });
      } else {
        observations.push({
          turnId: turn.id,
          status: turn.status,
          terminalKind: kind,
          contentState: "pending",
          disposition: "monitoring",
          terminalFirstObservedAt,
          settleDeadlineAt,
          replaceTerminalKind,
        });
      }
    }
    return observations;
  }

  private nextReconcile(observations: readonly ObservationCommit[]): number {
    return observations.some((observation) =>
      observation.status === "inProgress" || observation.contentState === "pending")
      ? this.now() + this.pollIntervalMs
      : this.now() + this.coldReconcileMs;
  }

  private currentRecency(threadId: string): number | null {
    return this.catalog.getRecencyAtMs(threadId);
  }

  private updateHealth(): void {
    const initialCounts = this.observerState.baselineCounts();
    const deferredThreads = this.observerState.deferredCount();
    const initialDone = this.observerState.getMeta()?.bootstrapInitialPassCompletedAt != null;
    this._health = initialDone
      ? {
          history: deferredThreads > 0 ? "degraded" : "ready",
          notifications: deferredThreads > 0 ? "degraded" : "ready",
          deferredThreads,
        }
      : { history: "initializing", notifications: "initializing", deferredThreads: Math.max(initialCounts.deferred, deferredThreads) };
  }

  private recordPollFailure(error: unknown): void {
    const key = errorCode(error);
    const now = this.now();
    if (this.pollFailureKey !== key) {
      this.pollFailureKey = key;
      this.pollFailureCount = 0;
      this.pollFailureSince = now;
      this.pollFailureLastLoggedAt = 0;
    }
    this.pollFailureCount += 1;
    if (this.pollFailureLastLoggedAt === 0 || now - this.pollFailureLastLoggedAt >= POLL_FAILURE_LOG_INTERVAL_MS) {
      this.pollFailureLastLoggedAt = now;
      this.logger.warn("desktop_observer_poll_failed", { errorCode: key, failureCount: this.pollFailureCount });
    }
  }

  private recordPollRecovery(): void {
    if (!this.pollFailureKey) return;
    this.logger.info("desktop_observer_poll_recovered", {
      errorCode: this.pollFailureKey,
      failureCount: this.pollFailureCount,
      durationMs: Math.max(0, this.now() - this.pollFailureSince),
    });
    this.pollFailureKey = null;
    this.pollFailureCount = 0;
    this.pollFailureSince = 0;
    this.pollFailureLastLoggedAt = 0;
  }

  private async runDelivery(): Promise<void> {
    if (this.activeDelivery || this.stopped) return;
    const task = this.deliverPendingNotifications();
    this.activeDelivery = task;
    try {
      await task;
    } finally {
      if (this.activeDelivery === task) this.activeDelivery = null;
    }
  }

  private async deliverPendingNotifications(): Promise<void> {
    for (const notification of this.messages.listPendingNotifications(this.now())) {
      const buttons: InlineButton[][] = [[{ text: "💬 回复", callback_data: "reply:" + notification.threadId }]];
      try {
        const message = await this.telegram.sendMessage(notification.chatId, notification.text, buttons, false);
        this.messages.completeNotification(notification.eventFingerprint, message.message_id, this.now());
        this.logger.info("desktop_message_notified", {
          threadId: notification.threadId,
          turnId: notification.turnId,
          kind: notification.eventKind,
          textLength: notification.text.length,
        });
      } catch (error) {
        const retryDelayMs = Math.min(5_000 * 2 ** Math.min(notification.attemptCount, 6), 5 * 60_000);
        const attemptCount = this.messages.markNotificationFailed(
          notification.eventFingerprint,
          String(error),
          this.now() + retryDelayMs,
          this.now(),
        );
        this.logger.warn("desktop_notification_delivery_failed", {
          threadId: notification.threadId,
          turnId: notification.turnId,
          kind: notification.eventKind,
          attemptCount,
          retryDelayMs,
          textLength: notification.text.length,
          error: String(error),
        });
      }
    }
  }
}

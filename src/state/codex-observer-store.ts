import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { StateDb } from "./db.ts";
import type { DesktopMessageEventKind } from "./desktop-message-store.ts";
import type { CodexTurnStatus } from "../desktop/codex-read-service.ts";

export const CODEX_OBSERVER_SCHEMA_VERSION = 1;

export type BaselineState = "pending" | "monitoring" | "deferred";
export type ObservationDisposition = "monitoring" | "baseline_suppressed" | "already_known" | "notification_enqueued";
export type ObservationContentState = "not_applicable" | "pending" | "ready" | "confirmed_empty" | "timeout_unconfirmed";

export interface CodexObserverMeta {
  schemaVersion: number;
  schemaInitializedAt: number;
  codexHomeIdentity: string;
  bootstrapStartedAt: number | null;
  bootstrapInitialPassCompletedAt: number | null;
  bootstrapCatalogGeneration: number | null;
}

export interface CodexObserverThreadState {
  threadId: string;
  bootstrapMember: boolean;
  baselineState: BaselineState;
  anchorTurnId: string | null;
  monitoringStartedAt: number | null;
  monitorFromAt: number;
  nextHistoryReconcileAt: number;
  lastReconciledAt: number | null;
  firstDiscoveredAt: number | null;
  lastRecencyAtMs: number | null;
  lastError: string | null;
}

export interface CodexTurnObservation {
  threadId: string;
  turnId: string;
  lastStatus: CodexTurnStatus;
  terminalKind: "completed" | "failed" | "interrupted" | null;
  contentState: ObservationContentState;
  disposition: ObservationDisposition;
  finalTextHash: string | null;
  terminalFirstObservedAt: number | null;
  settleDeadlineAt: number | null;
  firstObservedAt: number;
  lastObservedAt: number;
}

export interface ObservationCommit {
  turnId: string;
  status: CodexTurnStatus;
  terminalKind: "completed" | "failed" | "interrupted" | null;
  contentState: ObservationContentState;
  disposition: ObservationDisposition;
  finalTextHash?: string | null;
  terminalFirstObservedAt?: number | null;
  settleDeadlineAt?: number | null;
  replaceTerminalKind?: boolean;
  notification?: {
    chatId: string;
    eventKind: "completed" | "failed" | "interrupted";
    text: string;
    correctionFromInterrupted?: boolean;
  };
}

export interface ThreadRefreshCommit {
  threadId: string;
  observations: ObservationCommit[];
  anchorTurnId: string | null;
  baselineState: BaselineState;
  monitoringStartedAt?: number | null;
  nextHistoryReconcileAt: number;
  lastReconciledAt: number;
  lastRecencyAtMs?: number | null;
  lastError?: string | null;
}

interface ObserverStateRow {
  thread_id: string;
  bootstrap_member: number;
  baseline_state: BaselineState;
  anchor_turn_id: string | null;
  monitoring_started_at: number | null;
  monitor_from_at: number;
  next_history_reconcile_at: number;
  last_reconciled_at: number | null;
  first_discovered_at: number | null;
  last_recency_at_ms: number | null;
  last_error: string | null;
}

interface TurnObservationRow {
  thread_id: string;
  turn_id: string;
  last_status: CodexTurnStatus;
  terminal_kind: CodexTurnObservation["terminalKind"];
  content_state: ObservationContentState;
  disposition: ObservationDisposition;
  final_text_hash: string | null;
  terminal_first_observed_at: number | null;
  settle_deadline_at: number | null;
  first_observed_at: number;
  last_observed_at: number;
}

interface ObserverMetaRow {
  schema_version: number;
  schema_initialized_at: number;
  codex_home_identity: string;
  bootstrap_started_at: number | null;
  bootstrap_initial_pass_completed_at: number | null;
  bootstrap_catalog_generation: number | null;
}

function environmentIdentity(codexHome: string): string {
  return resolve(codexHome);
}

export function terminalFingerprint(threadId: string, turnId: string): string {
  return createHash("sha256").update(JSON.stringify({ threadId, turnId, eventClass: "terminal" })).digest("hex");
}

export function terminalCorrectionFingerprint(threadId: string, turnId: string): string {
  return createHash("sha256").update(JSON.stringify({
    threadId,
    turnId,
    eventClass: "terminal_correction",
    from: "interrupted",
    to: "completed",
  })).digest("hex");
}

export function textHash(text: string | null): string | null {
  return text == null ? null : createHash("sha256").update(text).digest("hex");
}

/** Durable observer state for the app-server based Codex history reader. */
export class CodexObserverStore {
  private readonly identity: string;

  constructor(
    private readonly state: StateDb,
    codexHome: string,
  ) {
    this.identity = environmentIdentity(codexHome);
  }

  ensureEnvironment(now = Date.now()): "ready" | "reinitialize_required" {
    return this.state.db.transaction(() => {
      const existing = this.meta();
      if (!existing) {
        this.state.db.query(`
          INSERT INTO desktop_observer_meta(singleton_id,schema_version,schema_initialized_at,codex_home_identity)
          VALUES(1,?,?,?)
        `).run(CODEX_OBSERVER_SCHEMA_VERSION, now, this.identity);
        return "ready" as const;
      }
      if (existing.codexHomeIdentity !== this.identity) return "reinitialize_required" as const;
      if (existing.schemaVersion !== CODEX_OBSERVER_SCHEMA_VERSION) throw new Error("codex_observer_schema_unsupported");
      return "ready" as const;
    })();
  }

  getMeta(): CodexObserverMeta | null {
    return this.meta();
  }

  beginBootstrap(now = Date.now()): number {
    return this.state.db.transaction(() => {
      this.requireIdentity();
      const meta = this.meta();
      if (!meta) throw new Error("codex_observer_meta_missing");
      if (meta.bootstrapStartedAt != null) return meta.bootstrapStartedAt;
      this.state.db.query("UPDATE desktop_observer_meta SET bootstrap_started_at=? WHERE singleton_id=1 AND bootstrap_started_at IS NULL").run(now);
      return now;
    })();
  }

  freezeInitialCatalog(threadIds: readonly string[], catalogGeneration: number, now = Date.now()): void {
    this.state.db.transaction(() => {
      const meta = this.requireIdentity();
      if (meta.bootstrapStartedAt == null) throw new Error("codex_bootstrap_not_started");
      this.state.db.query("UPDATE desktop_observer_meta SET bootstrap_catalog_generation=? WHERE singleton_id=1 AND bootstrap_catalog_generation IS NULL").run(catalogGeneration);
      for (const threadId of threadIds) {
        this.state.db.query(`
          INSERT INTO desktop_observer_state(
            thread_id,bootstrap_member,baseline_state,anchor_turn_id,monitoring_started_at,
            monitor_from_at,next_history_reconcile_at,last_reconciled_at,first_discovered_at,
            last_recency_at_ms,last_error,updated_at
          ) VALUES(?,1,'pending',NULL,NULL,?,?,NULL,?,NULL,NULL,?)
          ON CONFLICT(thread_id) DO UPDATE SET bootstrap_member=1,updated_at=excluded.updated_at
        `).run(threadId, meta.bootstrapStartedAt, now, now, now);
      }
    })();
  }

  registerCreatedThread(threadId: string, now = Date.now()): void {
    this.state.db.transaction(() => {
      this.requireIdentity();
      this.state.db.query(`
        INSERT INTO desktop_observer_state(
          thread_id,bootstrap_member,baseline_state,anchor_turn_id,monitoring_started_at,
          monitor_from_at,next_history_reconcile_at,last_reconciled_at,first_discovered_at,
          last_recency_at_ms,last_error,updated_at
        ) VALUES(?,0,'monitoring',NULL,?,?,?,NULL,?,NULL,NULL,?)
        ON CONFLICT(thread_id) DO UPDATE SET
          monitor_from_at=MIN(desktop_observer_state.monitor_from_at,excluded.monitor_from_at),
          baseline_state='monitoring',
          next_history_reconcile_at=MIN(desktop_observer_state.next_history_reconcile_at,excluded.next_history_reconcile_at),
          updated_at=excluded.updated_at
      `).run(threadId, now, now, now, now, now);
    })();
  }

  ensureDiscoveredThread(threadId: string, recencyAtMs: number | null, now = Date.now()): CodexObserverThreadState {
    return this.state.db.transaction(() => {
      const meta = this.requireIdentity();
      if (meta.bootstrapStartedAt == null) throw new Error("codex_bootstrap_not_started");
      this.state.db.query(`
        INSERT OR IGNORE INTO desktop_observer_state(
          thread_id,bootstrap_member,baseline_state,anchor_turn_id,monitoring_started_at,
          monitor_from_at,next_history_reconcile_at,last_reconciled_at,first_discovered_at,
          last_recency_at_ms,last_error,updated_at
        ) VALUES(?,0,'pending',NULL,NULL,?,?,NULL,?,?,NULL,?)
      `).run(threadId, meta.bootstrapStartedAt, now, now, recencyAtMs, now);
      const state = this.getThreadState(threadId);
      if (!state) throw new Error("codex_observer_state_insert_failed");
      return state;
    })();
  }

  getThreadState(threadId: string): CodexObserverThreadState | null {
    const row = this.state.db.query(`
      SELECT thread_id,bootstrap_member,baseline_state,anchor_turn_id,monitoring_started_at,
             monitor_from_at,next_history_reconcile_at,last_reconciled_at,first_discovered_at,
             last_recency_at_ms,last_error
      FROM desktop_observer_state WHERE thread_id=?
    `).get(threadId) as ObserverStateRow | null;
    return row ? this.mapState(row) : null;
  }

  listInitialPending(limit = 20): CodexObserverThreadState[] {
    const rows = this.state.db.query(`
      SELECT thread_id,bootstrap_member,baseline_state,anchor_turn_id,monitoring_started_at,
             monitor_from_at,next_history_reconcile_at,last_reconciled_at,first_discovered_at,
             last_recency_at_ms,last_error
      FROM desktop_observer_state
      WHERE bootstrap_member=1 AND baseline_state='pending'
      ORDER BY updated_at,thread_id LIMIT ?
    `).all(limit) as ObserverStateRow[];
    return rows.map((row) => this.mapState(row));
  }

  listUrgentDue(now = Date.now(), limit = 20): CodexObserverThreadState[] {
    const rows = this.state.db.query(`
      SELECT s.thread_id,s.bootstrap_member,s.baseline_state,s.anchor_turn_id,s.monitoring_started_at,
             s.monitor_from_at,s.next_history_reconcile_at,s.last_reconciled_at,s.first_discovered_at,
             s.last_recency_at_ms,s.last_error
      FROM desktop_observer_state s
      WHERE s.baseline_state IN ('monitoring','deferred')
        AND s.next_history_reconcile_at<=?
        AND EXISTS (
          SELECT 1 FROM desktop_turn_observations o
          WHERE o.thread_id=s.thread_id
            AND o.disposition='monitoring'
            AND (o.last_status='inProgress' OR o.content_state='pending')
        )
      ORDER BY s.next_history_reconcile_at,s.thread_id LIMIT ?
    `).all(now, limit) as ObserverStateRow[];
    return rows.map((row) => this.mapState(row));
  }

  listColdDue(now = Date.now(), limit = 20): CodexObserverThreadState[] {
    const rows = this.state.db.query(`
      SELECT s.thread_id,s.bootstrap_member,s.baseline_state,s.anchor_turn_id,s.monitoring_started_at,
             s.monitor_from_at,s.next_history_reconcile_at,s.last_reconciled_at,s.first_discovered_at,
             s.last_recency_at_ms,s.last_error
      FROM desktop_observer_state s
      WHERE s.baseline_state IN ('monitoring','deferred')
        AND s.next_history_reconcile_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM desktop_turn_observations o
          WHERE o.thread_id=s.thread_id
            AND o.disposition='monitoring'
            AND (o.last_status='inProgress' OR o.content_state='pending')
        )
      ORDER BY CASE s.baseline_state WHEN 'deferred' THEN 0 ELSE 1 END,
               s.next_history_reconcile_at,s.thread_id LIMIT ?
    `).all(now, limit) as ObserverStateRow[];
    return rows.map((row) => this.mapState(row));
  }

  listDue(now = Date.now(), limit = 20): CodexObserverThreadState[] {
    const rows = this.state.db.query(`
      SELECT thread_id,bootstrap_member,baseline_state,anchor_turn_id,monitoring_started_at,
             monitor_from_at,next_history_reconcile_at,last_reconciled_at,first_discovered_at,
             last_recency_at_ms,last_error
      FROM desktop_observer_state
      WHERE baseline_state IN ('monitoring','deferred') AND next_history_reconcile_at<=?
      ORDER BY CASE baseline_state WHEN 'deferred' THEN 0 ELSE 1 END,next_history_reconcile_at,thread_id LIMIT ?
    `).all(now, limit) as ObserverStateRow[];
    return rows.map((row) => this.mapState(row));
  }

  listChangedHot(threads: readonly { id: string; recencyAtMs: number | null }[], now = Date.now()): CodexObserverThreadState[] {
    const changed: CodexObserverThreadState[] = [];
    for (const thread of threads) {
      const state = this.ensureDiscoveredThread(thread.id, thread.recencyAtMs, now);
      if (state.baselineState === "pending") {
        changed.push(state);
        continue;
      }
      if (state.baselineState === "deferred") {
        if (state.nextHistoryReconcileAt <= now) changed.push(state);
        continue;
      }
      if (state.lastRecencyAtMs !== thread.recencyAtMs) changed.push(state);
    }
    return changed;
  }

  getObservation(threadId: string, turnId: string): CodexTurnObservation | null {
    const row = this.state.db.query(`
      SELECT thread_id,turn_id,last_status,terminal_kind,content_state,disposition,final_text_hash,
             terminal_first_observed_at,settle_deadline_at,first_observed_at,last_observed_at
      FROM desktop_turn_observations WHERE thread_id=? AND turn_id=?
    `).get(threadId, turnId) as TurnObservationRow | null;
    return row ? this.mapObservation(row) : null;
  }

  /** Keep notified interruptions in the overlap scan until a completion correction is observed. */
  pendingTurnIds(threadId: string): string[] {
    const rows = this.state.db.query(`
      SELECT turn_id FROM desktop_turn_observations
      WHERE thread_id=? AND (disposition='monitoring'
        OR (terminal_kind='interrupted' AND disposition IN ('notification_enqueued','already_known')))
      ORDER BY first_observed_at,turn_id
    `).all(threadId) as Array<{ turn_id: string }>;
    return rows.map((row) => row.turn_id);
  }

  commitThreadRefresh(input: ThreadRefreshCommit, now = Date.now()): void {
    this.state.db.transaction(() => {
      this.requireIdentity();
      for (const observation of input.observations) {
        let disposition = observation.disposition;
        if (observation.notification) {
          const correction = observation.notification.correctionFromInterrupted === true;
          if (correction) {
            const kinds = this.terminalIdentityKinds(input.threadId, observation.turnId);
            if (kinds.has("completed")) {
              disposition = "already_known";
            } else if (observation.notification.eventKind !== "completed" || kinds.size !== 1 || !kinds.has("interrupted")) {
              throw new Error("codex_terminal_correction_invalid");
            } else {
              this.state.db.query(`
                DELETE FROM desktop_notification_outbox
                WHERE thread_id=? AND turn_id=? AND event_kind='interrupted' AND status='pending'
              `).run(input.threadId, observation.turnId);
              const fingerprint = terminalCorrectionFingerprint(input.threadId, observation.turnId);
              this.state.db.query(`
                INSERT OR IGNORE INTO desktop_notification_outbox(
                  event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,status,
                  attempt_count,next_attempt_at,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)
              `).run(
                fingerprint,
                observation.notification.chatId,
                input.threadId,
                observation.turnId,
                observation.notification.eventKind,
                observation.notification.text,
                now,
                now,
                now,
              );
              disposition = "notification_enqueued";
            }
          } else if (this.hasTerminalIdentity(input.threadId, observation.turnId)) {
            disposition = "already_known";
          } else {
            const fingerprint = terminalFingerprint(input.threadId, observation.turnId);
            this.state.db.query(`
              INSERT OR IGNORE INTO desktop_notification_outbox(
                event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,status,
                attempt_count,next_attempt_at,created_at,updated_at
              ) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)
            `).run(
              fingerprint,
              observation.notification.chatId,
              input.threadId,
              observation.turnId,
              observation.notification.eventKind,
              observation.notification.text,
              now,
              now,
              now,
            );
            disposition = "notification_enqueued";
          }
        }
        const previous = this.getObservation(input.threadId, observation.turnId);
        this.state.db.query(`
          INSERT INTO desktop_turn_observations(
            thread_id,turn_id,last_status,terminal_kind,content_state,disposition,final_text_hash,
            terminal_first_observed_at,settle_deadline_at,first_observed_at,last_observed_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id,turn_id) DO UPDATE SET
            last_status=excluded.last_status,
            terminal_kind=CASE
              WHEN ?=1 THEN excluded.terminal_kind
              ELSE COALESCE(desktop_turn_observations.terminal_kind,excluded.terminal_kind)
            END,
            content_state=excluded.content_state,
            disposition=CASE
              WHEN desktop_turn_observations.disposition IN ('notification_enqueued','already_known','baseline_suppressed')
                THEN desktop_turn_observations.disposition
              ELSE excluded.disposition
            END,
            final_text_hash=COALESCE(excluded.final_text_hash,desktop_turn_observations.final_text_hash),
            terminal_first_observed_at=COALESCE(desktop_turn_observations.terminal_first_observed_at,excluded.terminal_first_observed_at),
            settle_deadline_at=COALESCE(desktop_turn_observations.settle_deadline_at,excluded.settle_deadline_at),
            last_observed_at=excluded.last_observed_at
        `).run(
          input.threadId,
          observation.turnId,
          observation.status,
          observation.terminalKind,
          observation.contentState,
          disposition,
          observation.finalTextHash ?? null,
          observation.terminalFirstObservedAt ?? null,
          observation.settleDeadlineAt ?? null,
          previous?.firstObservedAt ?? now,
          now,
          observation.replaceTerminalKind ? 1 : 0,
        );
      }
      this.state.db.query(`
        UPDATE desktop_observer_state SET
          baseline_state=?,anchor_turn_id=?,monitoring_started_at=COALESCE(monitoring_started_at,?),
          next_history_reconcile_at=?,last_reconciled_at=?,last_recency_at_ms=?,last_error=?,updated_at=?
        WHERE thread_id=?
      `).run(
        input.baselineState,
        input.anchorTurnId,
        input.monitoringStartedAt ?? null,
        input.nextHistoryReconcileAt,
        input.lastReconciledAt,
        input.lastRecencyAtMs ?? null,
        input.lastError ?? null,
        now,
        input.threadId,
      );
    })();
  }

  markDeferred(threadId: string, error: string, retryAt: number, now = Date.now()): void {
    this.state.db.query(`
      UPDATE desktop_observer_state
      SET baseline_state='deferred',next_history_reconcile_at=?,last_error=?,updated_at=?
      WHERE thread_id=?
    `).run(retryAt, error.slice(0, 500), now, threadId);
  }

  completeInitialPass(now = Date.now()): boolean {
    return this.state.db.transaction(() => {
      const meta = this.requireIdentity();
      if (meta.bootstrapInitialPassCompletedAt != null) return true;
      const pending = this.state.db.query("SELECT 1 AS found FROM desktop_observer_state WHERE bootstrap_member=1 AND baseline_state='pending' LIMIT 1").get();
      if (pending) return false;
      this.state.db.query("UPDATE desktop_observer_meta SET bootstrap_initial_pass_completed_at=? WHERE singleton_id=1").run(now);
      return true;
    })();
  }

  deferredCount(): number {
    const row = this.state.db.query("SELECT COUNT(*) AS count FROM desktop_observer_state WHERE baseline_state='deferred'").get() as { count: number };
    return Number(row.count);
  }

  baselineCounts(): { pending: number; monitoring: number; deferred: number } {
    const rows = this.state.db.query(`
      SELECT baseline_state AS state,COUNT(*) AS count
      FROM desktop_observer_state WHERE bootstrap_member=1 GROUP BY baseline_state
    `).all() as Array<{ state: BaselineState; count: number }>;
    const result = { pending: 0, monitoring: 0, deferred: 0 };
    for (const row of rows) result[row.state] = Number(row.count);
    return result;
  }

  clearForEnvironmentReset(now = Date.now()): void {
    this.state.db.transaction(() => {
      this.state.db.run("DELETE FROM desktop_turn_observations");
      this.state.db.run("DELETE FROM desktop_observer_state");
      this.state.db.run("DELETE FROM desktop_observer_meta");
      this.state.db.query(`
        INSERT INTO desktop_observer_meta(singleton_id,schema_version,schema_initialized_at,codex_home_identity)
        VALUES(1,?,?,?)
      `).run(CODEX_OBSERVER_SCHEMA_VERSION, now, this.identity);
    })();
  }

  terminalIdentityKinds(threadId: string, turnId: string): Set<"completed" | "failed" | "interrupted"> {
    const rows = this.state.db.query(`
      SELECT event_kind FROM desktop_message_links
      WHERE thread_id=? AND turn_id=? AND event_kind IN ('completed','failed','interrupted')
      UNION
      SELECT event_kind FROM desktop_notification_outbox
      WHERE thread_id=? AND turn_id=? AND event_kind IN ('completed','failed','interrupted')
    `).all(threadId, turnId, threadId, turnId) as Array<{ event_kind: "completed" | "failed" | "interrupted" }>;
    return new Set(rows.map((row) => row.event_kind));
  }

  hasTerminalIdentity(threadId: string, turnId: string): boolean {
    return this.terminalIdentityKinds(threadId, turnId).size > 0;
  }

  private meta(): CodexObserverMeta | null {
    const row = this.state.db.query(`
      SELECT schema_version,schema_initialized_at,codex_home_identity,bootstrap_started_at,
             bootstrap_initial_pass_completed_at,bootstrap_catalog_generation
      FROM desktop_observer_meta WHERE singleton_id=1
    `).get() as ObserverMetaRow | null;
    if (!row) return null;
    return {
      schemaVersion: Number(row.schema_version),
      schemaInitializedAt: Number(row.schema_initialized_at),
      codexHomeIdentity: String(row.codex_home_identity),
      bootstrapStartedAt: row.bootstrap_started_at == null ? null : Number(row.bootstrap_started_at),
      bootstrapInitialPassCompletedAt: row.bootstrap_initial_pass_completed_at == null ? null : Number(row.bootstrap_initial_pass_completed_at),
      bootstrapCatalogGeneration: row.bootstrap_catalog_generation == null ? null : Number(row.bootstrap_catalog_generation),
    };
  }

  private requireIdentity(): CodexObserverMeta {
    const meta = this.meta();
    if (!meta) throw new Error("codex_observer_meta_missing");
    if (meta.codexHomeIdentity !== this.identity) throw new Error("codex_observer_home_mismatch");
    return meta;
  }

  private mapState(row: ObserverStateRow): CodexObserverThreadState {
    return {
      threadId: String(row.thread_id),
      bootstrapMember: Number(row.bootstrap_member) === 1,
      baselineState: row.baseline_state as BaselineState,
      anchorTurnId: row.anchor_turn_id == null ? null : String(row.anchor_turn_id),
      monitoringStartedAt: row.monitoring_started_at == null ? null : Number(row.monitoring_started_at),
      monitorFromAt: Number(row.monitor_from_at),
      nextHistoryReconcileAt: Number(row.next_history_reconcile_at),
      lastReconciledAt: row.last_reconciled_at == null ? null : Number(row.last_reconciled_at),
      firstDiscoveredAt: row.first_discovered_at == null ? null : Number(row.first_discovered_at),
      lastRecencyAtMs: row.last_recency_at_ms == null ? null : Number(row.last_recency_at_ms),
      lastError: row.last_error == null ? null : String(row.last_error),
    };
  }

  private mapObservation(row: TurnObservationRow): CodexTurnObservation {
    return {
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      lastStatus: row.last_status as CodexTurnStatus,
      terminalKind: row.terminal_kind as CodexTurnObservation["terminalKind"],
      contentState: row.content_state as ObservationContentState,
      disposition: row.disposition as ObservationDisposition,
      finalTextHash: row.final_text_hash == null ? null : String(row.final_text_hash),
      terminalFirstObservedAt: row.terminal_first_observed_at == null ? null : Number(row.terminal_first_observed_at),
      settleDeadlineAt: row.settle_deadline_at == null ? null : Number(row.settle_deadline_at),
      firstObservedAt: Number(row.first_observed_at),
      lastObservedAt: Number(row.last_observed_at),
    };
  }
}

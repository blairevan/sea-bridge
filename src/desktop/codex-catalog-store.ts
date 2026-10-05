import { resolve } from "node:path";
import type { StateDb } from "../state/db.ts";
import type { CodexReadThread } from "./codex-read-service.ts";
import type { CodexThread, CodexThreadReader } from "./codex-thread-store.ts";
import type { CreationClient } from "./codex-provenance.ts";

export interface CodexCatalogHealth {
  state: "ready" | "stale" | "unavailable" | "reinitialize_required";
  observedAt: number | null;
  fullReconciledAt: number | null;
  generation: number;
  completeness: "full" | "partial" | null;
}

interface MetaRow {
  codex_home_identity: string;
  generation: number;
  full_reconciled_at: number | null;
  completeness: "full" | "partial";
  observed_at: number;
}

function homeIdentity(codexHome: string): string {
  return resolve(codexHome);
}

/** Sea-Bridge-owned last-known-good catalog; no read path reaches Codex SQLite. */
export class CodexCatalogStore implements CodexThreadReader {
  private readonly identity: string;

  constructor(
    private readonly state: StateDb,
    codexHome: string,
  ) {
    this.identity = homeIdentity(codexHome);
  }

  listActive(): CodexThread[] {
    if (this.identityMismatch()) return [];
    const rows = this.state.db.query(`
      SELECT thread_id,title,rollout_path,updated_at_ms,creation_client_kind,creation_client_evidence
      FROM desktop_codex_catalog
      ORDER BY updated_at_ms DESC,thread_id
    `).all() as Array<{
      thread_id: string;
      title: string;
      rollout_path: string | null;
      updated_at_ms: number;
      creation_client_kind: CreationClient["kind"];
      creation_client_evidence: CreationClient["evidence"];
    }>;
    return rows.map((row) => ({
      id: row.thread_id,
      title: row.title,
      rolloutPath: row.rollout_path,
      updatedAtMs: Number(row.updated_at_ms),
      creationClient: {
        kind: row.creation_client_kind,
        evidence: row.creation_client_evidence,
      },
    }));
  }

  getThread(threadId: string): CodexThread | null {
    if (this.identityMismatch()) return null;
    const row = this.state.db.query(`
      SELECT thread_id,title,rollout_path,updated_at_ms,creation_client_kind,creation_client_evidence
      FROM desktop_codex_catalog WHERE thread_id=?
    `).get(threadId) as {
      thread_id: string;
      title: string;
      rollout_path: string | null;
      updated_at_ms: number;
      creation_client_kind: CreationClient["kind"];
      creation_client_evidence: CreationClient["evidence"];
    } | null;
    if (!row) return null;
    return {
      id: row.thread_id,
      title: row.title,
      rolloutPath: row.rollout_path,
      updatedAtMs: Number(row.updated_at_ms),
      creationClient: {
        kind: row.creation_client_kind,
        evidence: row.creation_client_evidence,
      },
    };
  }

  isKnownThread(threadId: string): boolean {
    if (this.identityMismatch()) return false;
    return Boolean(this.state.db.query("SELECT 1 AS found FROM desktop_codex_catalog WHERE thread_id=?").get(threadId));
  }

  getRecencyAtMs(threadId: string): number | null {
    if (this.identityMismatch()) return null;
    const row = this.state.db.query("SELECT recency_at_ms FROM desktop_codex_catalog WHERE thread_id=?").get(threadId) as { recency_at_ms: number | null } | null;
    return row?.recency_at_ms == null ? null : Number(row.recency_at_ms);
  }

  health(now = Date.now(), staleAfterMs = 60_000): CodexCatalogHealth {
    const meta = this.meta();
    if (!meta) return { state: "unavailable", observedAt: null, fullReconciledAt: null, generation: 0, completeness: null };
    if (meta.codex_home_identity !== this.identity) {
      return {
        state: "reinitialize_required",
        observedAt: meta.observed_at,
        fullReconciledAt: meta.full_reconciled_at,
        generation: meta.generation,
        completeness: meta.completeness,
      };
    }
    return {
      state: now - meta.observed_at <= staleAfterMs ? "ready" : "stale",
      observedAt: meta.observed_at,
      fullReconciledAt: meta.full_reconciled_at,
      generation: meta.generation,
      completeness: meta.completeness,
    };
  }

  /** Commit one successful complete scan. Missing threads need two consecutive scans before removal. */
  commitFull(threads: readonly CodexReadThread[], observedAt = Date.now()): number {
    return this.state.db.transaction(() => {
      const meta = this.requireCompatibleOrEmpty();
      const generation = Number(meta?.generation ?? 0) + 1;
      this.state.db.run("UPDATE desktop_codex_catalog SET missing_count=missing_count+1");
      for (const thread of threads) this.upsertThread(thread, observedAt);
      this.state.db.run("DELETE FROM desktop_codex_catalog WHERE missing_count>=2");
      this.state.db.query(`
        INSERT INTO desktop_codex_catalog_meta(singleton_id,codex_home_identity,generation,full_reconciled_at,completeness,observed_at)
        VALUES(1,?,?,?,'full',?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          codex_home_identity=excluded.codex_home_identity,
          generation=excluded.generation,
          full_reconciled_at=excluded.full_reconciled_at,
          completeness='full',
          observed_at=excluded.observed_at
      `).run(this.identity, generation, observedAt, observedAt);
      return generation;
    })();
  }

  /** Merge a hot page without deleting anything outside the page. */
  mergeHot(threads: readonly CodexReadThread[], observedAt = Date.now()): number {
    return this.state.db.transaction(() => {
      const meta = this.requireCompatibleOrEmpty();
      const generation = Number(meta?.generation ?? 0) + 1;
      for (const thread of threads) this.upsertThread(thread, observedAt);
      this.state.db.query(`
        INSERT INTO desktop_codex_catalog_meta(singleton_id,codex_home_identity,generation,full_reconciled_at,completeness,observed_at)
        VALUES(1,?,?,NULL,'partial',?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          generation=excluded.generation,
          observed_at=excluded.observed_at
      `).run(this.identity, generation, observedAt);
      return generation;
    })();
  }

  clearForEnvironmentReset(): void {
    this.state.db.transaction(() => {
      this.state.db.run("DELETE FROM desktop_codex_catalog");
      this.state.db.run("DELETE FROM desktop_codex_catalog_meta");
    })();
  }

  private upsertThread(thread: CodexReadThread, observedAt: number): void {
    this.state.db.query(`
      INSERT INTO desktop_codex_catalog(
        thread_id,title,rollout_path,created_at_ms,updated_at_ms,recency_at_ms,
        creation_client_kind,creation_client_evidence,observed_at,missing_count
      ) VALUES(?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(thread_id) DO UPDATE SET
        title=excluded.title,
        rollout_path=excluded.rollout_path,
        created_at_ms=excluded.created_at_ms,
        updated_at_ms=excluded.updated_at_ms,
        recency_at_ms=excluded.recency_at_ms,
        creation_client_kind=excluded.creation_client_kind,
        creation_client_evidence=excluded.creation_client_evidence,
        observed_at=excluded.observed_at,
        missing_count=0
    `).run(
      thread.id,
      thread.title,
      thread.rolloutPath,
      thread.createdAtMs,
      thread.updatedAtMs,
      thread.recencyAtMs,
      thread.creationClient.kind,
      thread.creationClient.evidence,
      observedAt,
    );
  }

  private meta(): MetaRow | null {
    return this.state.db.query(`
      SELECT codex_home_identity,generation,full_reconciled_at,completeness,observed_at
      FROM desktop_codex_catalog_meta WHERE singleton_id=1
    `).get() as MetaRow | null;
  }

  private identityMismatch(): boolean {
    const meta = this.meta();
    return Boolean(meta && meta.codex_home_identity !== this.identity);
  }

  private requireCompatibleOrEmpty(): MetaRow | null {
    const meta = this.meta();
    if (meta && meta.codex_home_identity !== this.identity) throw new Error("codex_catalog_home_mismatch");
    return meta;
  }
}

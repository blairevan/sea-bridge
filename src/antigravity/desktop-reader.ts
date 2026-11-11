import { existsSync } from "node:fs";
import path from "node:path";
import type { WebHistory, WebSession } from "../web/sources/types.ts";
import {
  parseTimestampMs,
  queryReadOnlyDb,
  readBrainTranscriptHistory,
  type SummaryDbRow,
} from "./external-history.ts";
import {
  isValidDesktopConversationId,
  matchWorkspaceUriToProject,
  resolveAllowedProjectRoot,
  type AllowedAntigravityProject,
} from "./policy.ts";

export interface ExternalSessionInspection {
  found: boolean;
  title: string;
  updatedAt: number;
  externallyRunning: boolean;
  projectId: string | null;
  cwd: string | null;
}

export interface AnyExternalSessionInspection extends ExternalSessionInspection {
  clientKind: "desktop" | "cli";
  appDataDirPath: string | null;
}

/** Determine whether a CLI summary row is an empty ACP model-probe stub with no user prompt. */
function isEmptyCliStub(row: SummaryDbRow, clientKind: "desktop" | "cli"): boolean {
  return clientKind === "cli" && !row.title.trim() && !row.preview.trim();
}

/**
 * Read-only reader for external Antigravity sessions across `Antigravity.app` (`~/.gemini/antigravity`)
 * and `agy` CLI (`~/.gemini/antigravity-cli`). Desktop-only methods remain isolated for Telegram observer safety.
 */
export class AntigravityDesktopReader {
  constructor(
    private readonly options: {
      desktopAppDataDir: string;
      cliAppDataDir?: string | undefined;
      getAllowedProjects: () => readonly AllowedAntigravityProject[];
    }
  ) {}

  /** List top-level non-killed desktop sessions (`nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0`). */
  listSessions(limit = 200): WebSession[] {
    return this.queryDirectorySessions(this.options.desktopAppDataDir, limit, "desktop_only");
  }

  /** List external sessions across both Desktop (`~/.gemini/antigravity`) and CLI (`~/.gemini/antigravity-cli`). */
  listExternalSessions(limit = 200): WebSession[] {
    const merged = new Map<string, WebSession>();
    for (const item of this.queryDirectorySessions(this.options.desktopAppDataDir, limit, "all")) {
      merged.set(item.id, item);
    }
    const cliDir = this.distinctCliDir();
    if (cliDir) {
      for (const item of this.queryDirectorySessions(cliDir, limit, "cli_only")) {
        const prior = merged.get(item.id);
        if (!prior || item.updatedAt > prior.updatedAt) {
          merged.set(item.id, item);
        }
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  /** Read a single desktop session summary by conversation_id. */
  getSession(conversationId: string): WebSession | null {
    if (!isValidDesktopConversationId(conversationId)) return null;
    return this.listSessions(500).find((s) => s.id === conversationId) ?? null;
  }

  /** Read a single external session (Desktop or CLI) summary by conversation_id. */
  getExternalSession(conversationId: string): WebSession | null {
    const info = this.inspectAnyExternalSession(conversationId);
    if (!info.found) return null;
    return {
      source: "antigravity",
      id: conversationId,
      title: info.title,
      updatedAt: info.updatedAt,
      projectId: info.projectId,
      creationClient: { kind: info.clientKind, evidence: "explicit" },
      state: info.externallyRunning ? "running" : "idle",
      sendEnabled: false,
    };
  }

  /** Inspect an external desktop session's live running state and workspace project binding for P4 write adoption. */
  inspectExternalSession(conversationId: string): ExternalSessionInspection {
    const empty: ExternalSessionInspection = {
      found: false, title: conversationId, updatedAt: 0, externallyRunning: false, projectId: null, cwd: null,
    };
    if (!isValidDesktopConversationId(conversationId)) return empty;
    const row = this.querySingleRow(this.options.desktopAppDataDir, conversationId, true);
    if (!row) return empty;
    return this.toInspection(row);
  }

  /** Inspect an external session in either Desktop or CLI app-data directories, preserving its origin directory. */
  inspectAnyExternalSession(conversationId: string): AnyExternalSessionInspection {
    const empty: AnyExternalSessionInspection = {
      found: false, title: conversationId, updatedAt: 0, externallyRunning: false,
      projectId: null, cwd: null, clientKind: "desktop", appDataDirPath: null,
    };
    if (!isValidDesktopConversationId(conversationId)) return empty;

    const desktopRow = this.querySingleRow(this.options.desktopAppDataDir, conversationId, false);
    if (desktopRow) {
      const clientKind = desktopRow.source === "CORTEX_TRAJECTORY_SOURCE_CLI" ? "cli" : "desktop";
      if (!isEmptyCliStub(desktopRow, clientKind)) {
        return { ...this.toInspection(desktopRow), clientKind, appDataDirPath: this.options.desktopAppDataDir };
      }
    }

    const cliDir = this.distinctCliDir();
    if (cliDir) {
      const cliRow = this.querySingleRow(cliDir, conversationId, false);
      if (cliRow && !isEmptyCliStub(cliRow, "cli")) {
        return { ...this.toInspection(cliRow), clientKind: "cli", appDataDirPath: cliDir };
      }
    }
    return empty;
  }

  /** Discover distinct local workspace roots from `conversation_summaries.db` when explicit project configuration is absent. */
  discoverWorkspaceProjects(): AllowedAntigravityProject[] {
    const dirs = [this.options.desktopAppDataDir];
    const cliDir = this.distinctCliDir();
    if (cliDir) dirs.push(cliDir);

    const seenRoots = new Set<string>();
    const seenIds = new Set<string>();
    const projects: AllowedAntigravityProject[] = [];

    for (const dir of dirs) {
      const dbPath = path.join(dir, "conversation_summaries.db");
      if (!existsSync(dbPath)) continue;
      const rows = queryReadOnlyDb(dbPath, (db) =>
        db.query(
          `SELECT DISTINCT workspace_uris FROM conversation_summaries
           WHERE workspace_uris IS NOT NULL AND workspace_uris <> '' AND workspace_uris <> '[]'`
        ).all() as Array<{ workspace_uris: string }>
      );
      if (!rows) continue;
      for (const row of rows) {
        let uris: unknown;
        try { uris = JSON.parse(row.workspace_uris); } catch { continue; }
        if (!Array.isArray(uris)) continue;
        for (const uri of uris) {
          if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
          try {
            const decoded = decodeURIComponent(new URL(uri).pathname);
            if (/^\/(private\/)?(tmp|var\/folders)(\/|$)/.test(decoded)) continue;
            const rootPath = resolveAllowedProjectRoot(decoded);
            if (seenRoots.has(rootPath)) continue;
            seenRoots.add(rootPath);
            const baseName = path.basename(rootPath) || "root";
            let id = baseName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
            let suffix = 2;
            while (seenIds.has(id)) id = `${baseName.toLowerCase()}-${suffix++}`;
            seenIds.add(id);
            projects.push({ id, name: baseName, rootPath });
          } catch {
            // ignore missing or disallowed directories
          }
        }
      }
    }
    return projects;
  }

  /** Read and project a desktop session's `transcript.jsonl` (falling back to `transcript_full.jsonl` on truncated lines). */
  readHistory(conversationId: string, limit = 100): WebHistory | null {
    if (!isValidDesktopConversationId(conversationId)) return null;
    const session = this.getSession(conversationId);
    return readBrainTranscriptHistory(
      this.options.desktopAppDataDir,
      conversationId,
      session?.state,
      Boolean(session),
      limit,
    );
  }

  /** Read and project an external session's `transcript.jsonl` across Desktop and CLI app-data directories. */
  readExternalHistory(conversationId: string, limit = 100): WebHistory | null {
    if (!isValidDesktopConversationId(conversationId)) return null;
    const info = this.inspectAnyExternalSession(conversationId);
    if (info.found && info.appDataDirPath) {
      return readBrainTranscriptHistory(
        info.appDataDirPath,
        conversationId,
        info.externallyRunning ? "running" : "idle",
        true,
        limit,
      );
    }
    const candidates = [this.options.desktopAppDataDir];
    const cliDir = this.distinctCliDir();
    if (cliDir) candidates.push(cliDir);
    for (const dir of candidates) {
      const history = readBrainTranscriptHistory(dir, conversationId, undefined, false, limit);
      if (history) return history;
    }
    return null;
  }

  private distinctCliDir(): string | null {
    const raw = this.options.cliAppDataDir;
    if (!raw) return null;
    return path.resolve(raw) === path.resolve(this.options.desktopAppDataDir) ? null : raw;
  }

  private queryDirectorySessions(dirPath: string, limit: number, mode: "desktop_only" | "cli_only" | "all"): WebSession[] {
    const dbPath = path.join(dirPath, "conversation_summaries.db");
    if (!existsSync(dbPath)) return [];
    const rows = queryReadOnlyDb(dbPath, (db) => {
      const cols = db.query("PRAGMA table_info(conversation_summaries)").all() as Array<{ name: string }>;
      const hasSource = cols.some((c) => c.name === "source");
      const sourceClause = mode === "desktop_only" && hasSource ? " AND source <> 'CORTEX_TRAJECTORY_SOURCE_CLI'" : "";
      const selectSource = hasSource ? ", source" : "";
      return db.query(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle${selectSource}
         FROM conversation_summaries
         WHERE nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0${sourceClause}
         ORDER BY last_modified_time DESC
         LIMIT ?`
      ).all(limit) as SummaryDbRow[];
    });
    if (!rows) return [];

    const allowedProjects = this.options.getAllowedProjects();
    const sessions: WebSession[] = [];
    for (const row of rows) {
      if (!isValidDesktopConversationId(row.conversation_id)) continue;
      const clientKind: "desktop" | "cli" = mode === "cli_only" || row.source === "CORTEX_TRAJECTORY_SOURCE_CLI" ? "cli" : "desktop";
      if (isEmptyCliStub(row, clientKind)) continue;
      const updatedAt = parseTimestampMs(row.last_modified_time) ?? 0;
      const { projectId } = matchWorkspaceUriToProject(row.workspace_uris, allowedProjects);
      const isRunning = row.status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(row.not_fully_idle);
      const title = (row.title || row.preview || row.conversation_id).trim();
      sessions.push({
        source: "antigravity",
        id: row.conversation_id,
        title,
        updatedAt,
        projectId,
        creationClient: { kind: clientKind, evidence: "explicit" },
        state: isRunning ? "running" : "idle",
        sendEnabled: false,
      });
    }
    return sessions;
  }

  private querySingleRow(dirPath: string, conversationId: string, excludeCliSource: boolean): SummaryDbRow | null {
    const dbPath = path.join(dirPath, "conversation_summaries.db");
    if (!existsSync(dbPath)) return null;
    return queryReadOnlyDb(dbPath, (db) => {
      const cols = db.query("PRAGMA table_info(conversation_summaries)").all() as Array<{ name: string }>;
      const hasSource = cols.some((c) => c.name === "source");
      const sourceClause = excludeCliSource && hasSource ? " AND source <> 'CORTEX_TRAJECTORY_SOURCE_CLI'" : "";
      const selectSource = hasSource ? ", source" : "";
      return db.query(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle${selectSource}
         FROM conversation_summaries
         WHERE conversation_id = ? AND nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0${sourceClause}`
      ).get(conversationId) as SummaryDbRow | null;
    });
  }

  private toInspection(row: SummaryDbRow): ExternalSessionInspection {
    const { projectId, cwd } = matchWorkspaceUriToProject(row.workspace_uris, this.options.getAllowedProjects());
    const externallyRunning = row.status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(row.not_fully_idle);
    const title = (row.title || row.preview || row.conversation_id).trim();
    const updatedAt = parseTimestampMs(row.last_modified_time) ?? 0;
    return { found: true, title, updatedAt, externallyRunning, projectId, cwd };
  }
}

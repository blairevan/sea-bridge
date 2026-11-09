import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LiveActivityItem } from "../web/codex-transcript.ts";
import type { WebHistory, WebMessage, WebSession } from "../web/sources/types.ts";
import {
  isValidDesktopConversationId,
  matchWorkspaceUriToProject,
  resolveAllowedProjectRoot,
  resolveInsideDirectory,
  type AllowedAntigravityProject,
} from "./policy.ts";

interface DesktopSummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  not_fully_idle: number;
  source?: string;
}

export interface ExternalSessionInspection {
  found: boolean;
  title: string;
  updatedAt: number;
  externallyRunning: boolean;
  projectId: string | null;
  cwd: string | null;
}

function queryReadOnlyDb<T>(dbPath: string, fn: (db: Database) => T): T | null {
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?immutable=1`]) {
    let db: Database | null = null;
    try {
      db = new Database(uri, { readonly: true });
      return fn(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (uri.endsWith("mode=ro") && /CANTOPEN|unable to open/i.test(msg)) {
        continue;
      }
      return null;
    } finally {
      try {
        db?.close(false);
      } catch {
        // ignore close error
      }
    }
  }
  return null;
}

interface TranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
  truncated_fields?: string[];
}

function parseTimestampMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") {
    return ((content as { text: string }).text).trim();
  }
  return "";
}

function stripUserRequestTags(text: string): string {
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) return match[1].trim();
  return text.trim();
}

/**
 * Read-only reader for `Antigravity.app` (Desktop 2.0) sessions under `~/.gemini/antigravity`.
 * Strictly uses `mode=ro` SQLite connections and never invokes mutating `session/load`.
 */
export class AntigravityDesktopReader {
  constructor(
    private readonly options: {
      desktopAppDataDir: string;
      getAllowedProjects: () => readonly AllowedAntigravityProject[];
    }
  ) {}

  /** List top-level non-killed desktop sessions (`nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0`). */
  listSessions(limit = 200): WebSession[] {
    const dbPath = path.join(this.options.desktopAppDataDir, "conversation_summaries.db");
    if (!existsSync(dbPath)) return [];

    const rows = queryReadOnlyDb(dbPath, (db) => {
      const cols = db.query("PRAGMA table_info(conversation_summaries)").all() as Array<{ name: string }>;
      const hasSource = cols.some((c) => c.name === "source");
      const sql = hasSource
        ? `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle, source
           FROM conversation_summaries
           WHERE nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0 AND source <> 'CORTEX_TRAJECTORY_SOURCE_CLI'
           ORDER BY last_modified_time DESC
           LIMIT ?`
        : `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
           FROM conversation_summaries
           WHERE nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0
           ORDER BY last_modified_time DESC
           LIMIT ?`;
      return db.query(sql).all(limit) as DesktopSummaryRow[];
    });
    if (!rows) return [];

    const allowedProjects = this.options.getAllowedProjects();
    const sessions: WebSession[] = [];

    for (const row of rows) {
      if (!isValidDesktopConversationId(row.conversation_id)) continue;
      const updatedAt = parseTimestampMs(row.last_modified_time) ?? 0;
      const { projectId } = matchWorkspaceUriToProject(row.workspace_uris, allowedProjects);
      const isRunning = row.status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(row.not_fully_idle);
      const title = (row.title || row.preview || row.conversation_id).trim();

      sessions.push({
        source: "antigravity" as any,
        id: row.conversation_id,
        title,
        updatedAt,
        projectId,
        creationClient: { kind: "desktop", evidence: "explicit" },
        state: isRunning ? "running" : "idle",
        sendEnabled: false,
      });
    }
    return sessions;
  }

  /** Read a single desktop session summary by conversation_id. */
  getSession(conversationId: string): WebSession | null {
    if (!isValidDesktopConversationId(conversationId)) return null;
    const all = this.listSessions(500);
    return all.find((s) => s.id === conversationId) ?? null;
  }

  /** Inspect an external desktop session's live running state and workspace project binding for P4 write adoption. */
  inspectExternalSession(conversationId: string): ExternalSessionInspection {
    const empty: ExternalSessionInspection = {
      found: false,
      title: conversationId,
      updatedAt: 0,
      externallyRunning: false,
      projectId: null,
      cwd: null,
    };
    if (!isValidDesktopConversationId(conversationId)) return empty;
    const dbPath = path.join(this.options.desktopAppDataDir, "conversation_summaries.db");
    if (!existsSync(dbPath)) return empty;

    const row = queryReadOnlyDb(dbPath, (db) => {
      const cols = db.query("PRAGMA table_info(conversation_summaries)").all() as Array<{ name: string }>;
      const hasSource = cols.some((c) => c.name === "source");
      const sql = hasSource
        ? `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle, source
           FROM conversation_summaries
           WHERE conversation_id = ? AND nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0 AND source <> 'CORTEX_TRAJECTORY_SOURCE_CLI'`
        : `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
           FROM conversation_summaries
           WHERE conversation_id = ? AND nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0`;
      return db.query(sql).get(conversationId) as DesktopSummaryRow | null;
    });
    if (!row) return empty;

    const { projectId, cwd } = matchWorkspaceUriToProject(row.workspace_uris, this.options.getAllowedProjects());
    const externallyRunning = row.status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(row.not_fully_idle);
    const title = (row.title || row.preview || row.conversation_id).trim();
    const updatedAt = parseTimestampMs(row.last_modified_time) ?? 0;

    return {
      found: true,
      title,
      updatedAt,
      externallyRunning,
      projectId,
      cwd,
    };
  }

  /** Discover distinct local workspace roots from `conversation_summaries.db` when explicit project configuration is absent. */
  discoverWorkspaceProjects(): AllowedAntigravityProject[] {
    const dbPath = path.join(this.options.desktopAppDataDir, "conversation_summaries.db");
    if (!existsSync(dbPath)) return [];
    const rows = queryReadOnlyDb(dbPath, (db) =>
      db.query(
        `SELECT DISTINCT workspace_uris FROM conversation_summaries
         WHERE workspace_uris IS NOT NULL AND workspace_uris <> '' AND workspace_uris <> '[]'`
      ).all() as Array<{ workspace_uris: string }>
    );
    if (!rows) return [];
    const seenRoots = new Set<string>();
    const seenIds = new Set<string>();
    const projects: AllowedAntigravityProject[] = [];
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
    return projects;
  }

  /** Read and project a desktop session's `transcript.jsonl` (falling back to `transcript_full.jsonl` on truncated lines). */
  readHistory(conversationId: string, limit = 100): WebHistory | null {
    if (!isValidDesktopConversationId(conversationId)) return null;
    const brainRoot = path.join(this.options.desktopAppDataDir, "brain");
    if (!existsSync(brainRoot)) return null;

    const relativeCompact = path.join(conversationId, ".system_generated", "logs", "transcript.jsonl");
    const compactPath = resolveInsideDirectory(brainRoot, relativeCompact);
    const session = this.getSession(conversationId);
    if (!compactPath || !existsSync(compactPath)) {
      if (!session) return null;
      return {
        messages: [],
        cursor: null,
        completeUserHistory: true,
        sessionState: session.state,
      };
    }

    const relativeFull = path.join(conversationId, ".system_generated", "logs", "transcript_full.jsonl");
    const fullPath = resolveInsideDirectory(brainRoot, relativeFull);

    let compactLines: string[] = [];
    let fullLines: string[] | null = null;
    try {
      compactLines = readFileSync(compactPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    } catch {
      return null;
    }

    const getFullStep = (lineIndex: number, stepIndex?: number): TranscriptStep | null => {
      if (fullLines === null) {
        if (fullPath && existsSync(fullPath)) {
          try {
            fullLines = readFileSync(fullPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
          } catch {
            fullLines = [];
          }
        } else {
          fullLines = [];
        }
      }
      const direct = fullLines[lineIndex];
      if (direct) {
        try {
          const parsed = JSON.parse(direct) as TranscriptStep;
          if (stepIndex === undefined || parsed.step_index === stepIndex) return parsed;
        } catch {
          // fall through
        }
      }
      if (stepIndex !== undefined) {
        for (const candidate of fullLines) {
          try {
            const parsed = JSON.parse(candidate) as TranscriptStep;
            if (parsed.step_index === stepIndex) return parsed;
          } catch {
            continue;
          }
        }
      }
      return null;
    };

    const messages: WebMessage[] = [];
    const activeTurnItems: LiveActivityItem[] = [];

    for (let i = 0; i < compactLines.length; i++) {
      let step: TranscriptStep;
      try {
        step = JSON.parse(compactLines[i]!) as TranscriptStep;
      } catch {
        continue;
      }
      if (Array.isArray(step.truncated_fields) && step.truncated_fields.length > 0) {
        const hydrated = getFullStep(i, step.step_index);
        if (hydrated) step = hydrated;
      }

      const stepId = `step-${step.step_index ?? i}`;
      const createdAt = parseTimestampMs(step.created_at);

      if (step.type === "USER_INPUT") {
        const rawText = extractTextContent(step.content);
        const cleanText = stripUserRequestTags(rawText);
        if (cleanText) {
          messages.push({
            id: `${stepId}-user`,
            role: "user",
            text: cleanText,
            createdAt,
          });
        }
        continue;
      }

      if (step.type === "PLANNER_RESPONSE") {
        if (Array.isArray(step.tool_calls)) {
          for (let tIdx = 0; tIdx < step.tool_calls.length; tIdx++) {
            const tc = step.tool_calls[tIdx]!;
            const toolName = typeof tc.name === "string" ? tc.name : "tool";
            activeTurnItems.push({
              kind: "tool",
              text: toolName,
            });
          }
        }
        const replyText = extractTextContent(step.content);
        if (replyText) {
          messages.push({
            id: `${stepId}-assistant`,
            role: "assistant",
            text: replyText,
            createdAt,
          });
        }
      }
    }

    const bounded = messages.slice(-Math.max(1, Math.min(200, limit)));
    return {
      messages: bounded,
      cursor: null,
      completeUserHistory: true,
      ...(session ? { sessionState: session.state } : {}),
      ...(activeTurnItems.length > 0 ? { activeTurnItems: activeTurnItems.slice(-20) } : {}),
    };
  }
}

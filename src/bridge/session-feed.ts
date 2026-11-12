import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { WebRedaction } from "../web/redaction.ts";
import type {
  CatalogItem,
  SessionBridgeWorkspace,
  WebSession,
  WebSource,
} from "../web/sources/types.ts";
import {
  LocalBridgeError,
  type BridgeSessionFeedItem,
  type BridgeSessionFeedResponse,
} from "./types.ts";

/** Project descriptor carrying directory roots for longest-prefix workspace matching. */
export interface WorkspaceProjectCandidate {
  id: string;
  name: string;
  roots?: readonly string[];
  primaryRoot?: string;
}

const SYNC_SOURCES = ["codex", "antigravity"] as const;
const MAX_FEED_LIMIT = 200;
const DEFAULT_FEED_LIMIT = 100;
const REFRESH_BATCH_SIZE = 100;

/** Normalize a filesystem path without trailing slashes (except POSIX root `/`). */
function normalizeFsRoot(rawPath: string): string {
  const resolved = resolve(rawPath.trim());
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

/** Build a stable non-path-leaking fallback identifier for an unregistered directory. */
function buildUnregisteredDirId(normalizedCwd: string): { projectId: string; projectName: string } {
  const folder = basename(normalizedCwd) || "workspace";
  const slug = folder.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "dir";
  const digest = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 8);
  return {
    projectId: `dir:${slug}-${digest}`,
    projectName: folder,
  };
}

/**
 * Deterministically resolve a session's project identity by checking:
 * 1) explicit registered `projectId`,
 * 2) longest boundary-safe `cwd` root prefix match across registered projects,
 * 3) privacy-preserving directory slug hash when running in an unregistered folder.
 */
export function resolveWorkspaceProject(input: {
  explicitProjectId: string | null;
  cwd: string | null;
  projects: readonly WorkspaceProjectCandidate[];
  createdAtMs: number | null;
}): SessionBridgeWorkspace {
  const explicitId = input.explicitProjectId?.trim() || null;
  if (explicitId) {
    const byId = input.projects.find((proj) => proj.id === explicitId);
    if (byId) {
      return { projectId: byId.id, projectName: byId.name, createdAtMs: input.createdAtMs };
    }
  }

  const rawCwd = input.cwd?.trim() || null;
  if (rawCwd) {
    const normalizedCwd = normalizeFsRoot(rawCwd);
    let bestMatch: { project: WorkspaceProjectCandidate; rootLength: number } | null = null;
    for (const project of input.projects) {
      const candidateRoots = project.roots && project.roots.length > 0
        ? project.roots
        : project.primaryRoot
          ? [project.primaryRoot]
          : [];
      for (const root of candidateRoots) {
        if (!root?.trim()) continue;
        const normalizedRoot = normalizeFsRoot(root);
        const matches =
          normalizedCwd === normalizedRoot
          || (normalizedRoot === "/" ? normalizedCwd.startsWith("/") : normalizedCwd.startsWith(`${normalizedRoot}/`));
        if (matches && (!bestMatch || normalizedRoot.length > bestMatch.rootLength)) {
          bestMatch = { project, rootLength: normalizedRoot.length };
        }
      }
    }
    if (bestMatch) {
      return {
        projectId: bestMatch.project.id,
        projectName: bestMatch.project.name,
        createdAtMs: input.createdAtMs,
      };
    }
    if (explicitId) {
      return { projectId: explicitId, projectName: explicitId, createdAtMs: input.createdAtMs };
    }
    const fallback = buildUnregisteredDirId(normalizedCwd);
    return { ...fallback, createdAtMs: input.createdAtMs };
  }

  if (explicitId) {
    return { projectId: explicitId, projectName: explicitId, createdAtMs: input.createdAtMs };
  }
  return { projectId: "unassigned", projectName: "未归属工作区", createdAtMs: input.createdAtMs };
}

/** Parse and validate `sinceMs` and `limit` query parameters for `GET /v1/sessions`. */
export function parseSessionFeedQuery(searchParams: URLSearchParams): { sinceMs: number; limit: number } {
  const rawSince = searchParams.get("sinceMs");
  let sinceMs = 0;
  if (rawSince !== null && rawSince !== "") {
    if (!/^\d+$/.test(rawSince)) {
      throw new LocalBridgeError(400, "invalid_query");
    }
    sinceMs = Number(rawSince);
    if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
      throw new LocalBridgeError(400, "invalid_query");
    }
  }

  const rawLimit = searchParams.get("limit");
  let limit = DEFAULT_FEED_LIMIT;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) {
      throw new LocalBridgeError(400, "invalid_query");
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FEED_LIMIT) {
      throw new LocalBridgeError(400, "invalid_query");
    }
  }

  return { sinceMs, limit };
}

/** Check whether a session is currently in an active or waiting runtime state. */
function isActiveSessionState(state: WebSession["state"]): boolean {
  return state === "running" || state === "waiting_external_approval" || state === "waiting_user_input";
}

/** Refresh exact session IDs in bounded batches of 100 to obtain live execution states. */
async function refreshMatchedSessions(
  source: WebSource,
  ids: readonly string[],
): Promise<{ freshById: Map<string, WebSession>; failed: boolean }> {
  const freshById = new Map<string, WebSession>();
  let failed = false;
  for (let offset = 0; offset < ids.length; offset += REFRESH_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + REFRESH_BATCH_SIZE);
    try {
      const items = await source.sessions({ sessionIds: batch, limit: batch.length });
      for (const item of items) {
        if (batch.includes(item.id)) {
          freshById.set(item.id, item);
        }
      }
    } catch {
      failed = true;
    }
  }
  return { freshById, failed };
}

/**
 * Aggregate active and recent `codex` & `antigravity` sessions across CLI and Desktop
 * using two-phase filtering (`limit: 0` metadata scan -> bounded exact ID state refresh).
 */
export async function buildBridgeSessionFeed(
  deps: {
    sources: Partial<Record<"codex" | "antigravity" | "dsh", WebSource>>;
    redaction: WebRedaction;
  },
  options: { sinceMs: number; limit: number },
): Promise<BridgeSessionFeedResponse> {
  let partial = false;

  const sourceScans = await Promise.all(
    SYNC_SOURCES.map(async (sourceName) => {
      const source = deps.sources[sourceName];
      if (!source) return { sourceName, source: null, items: [] as WebSession[], projects: [] as CatalogItem[] };
      const [sessionsRes, projectsRes] = await Promise.allSettled([
        source.sessions({ limit: 0 }),
        source.projects(),
      ]);
      if (sessionsRes.status === "rejected") partial = true;
      return {
        sourceName,
        source,
        items: sessionsRes.status === "fulfilled" ? sessionsRes.value : [],
        projects: projectsRes.status === "fulfilled" ? projectsRes.value : [],
      };
    }),
  );

  const rawCandidates: Array<{
    sourceName: "codex" | "antigravity";
    source: WebSource;
    session: WebSession;
    projects: CatalogItem[];
  }> = [];

  for (const entry of sourceScans) {
    if (!entry.source) continue;
    for (const session of entry.items) {
      if (session.creationClient?.kind === "exec") continue;
      if (session.updatedAt >= options.sinceMs || isActiveSessionState(session.state)) {
        rawCandidates.push({
          sourceName: entry.sourceName,
          source: entry.source,
          session,
          projects: entry.projects,
        });
      }
    }
  }

  rawCandidates.sort(
    (a, b) => b.session.updatedAt - a.session.updatedAt || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0),
  );
  const selected = rawCandidates.slice(0, options.limit);

  const bySource = new Map<"codex" | "antigravity", { source: WebSource; ids: string[] }>();
  for (const item of selected) {
    const group = bySource.get(item.sourceName) ?? { source: item.source, ids: [] };
    group.ids.push(item.session.id);
    bySource.set(item.sourceName, group);
  }

  const refreshedBySource = new Map<"codex" | "antigravity", Map<string, WebSession>>();
  const workspacesBySource = new Map<"codex" | "antigravity", ReadonlyMap<string, SessionBridgeWorkspace>>();

  await Promise.all(
    Array.from(bySource.entries()).map(async ([sourceName, group]) => {
      const [refreshed, workspaces] = await Promise.all([
        refreshMatchedSessions(group.source, group.ids),
        group.source.bridgeWorkspaces
          ? group.source.bridgeWorkspaces(group.ids).catch(() => new Map<string, SessionBridgeWorkspace>())
          : Promise.resolve(new Map<string, SessionBridgeWorkspace>()),
      ]);
      if (refreshed.failed) partial = true;
      refreshedBySource.set(sourceName, refreshed.freshById);
      workspacesBySource.set(sourceName, workspaces);
    }),
  );

  const items: BridgeSessionFeedItem[] = [];
  for (const candidate of selected) {
    const live = refreshedBySource.get(candidate.sourceName)?.get(candidate.session.id) ?? candidate.session;
    if (live.creationClient?.kind === "exec") continue;

    const ws = workspacesBySource.get(candidate.sourceName)?.get(live.id)
      ?? resolveWorkspaceProject({
        explicitProjectId: live.projectId,
        cwd: null,
        projects: candidate.projects,
        createdAtMs: null,
      });

    const kind = live.creationClient?.kind;
    const clientTarget: "cli" | "desktop" | null =
      kind === "cli" ? "cli" : kind === "desktop" ? "desktop" : null;
    const normalizedState: BridgeSessionFeedItem["state"] =
      live.state === "waiting_user_input" ? "waiting_external_approval" : live.state;

    items.push({
      source: candidate.sourceName,
      sessionId: live.id,
      clientTarget,
      title: deps.redaction.storage((live.title || live.id).slice(0, 300)),
      projectId: ws.projectId,
      projectName: deps.redaction.storage(ws.projectName.slice(0, 120)),
      modelId: live.sessionMeta?.model?.id ?? null,
      reasoningEffort: live.sessionMeta?.reasoningEffort ?? null,
      state: normalizedState,
      createdAtMs: ws.createdAtMs && ws.createdAtMs > 0 ? ws.createdAtMs : live.updatedAt,
      updatedAtMs: live.updatedAt,
    });
  }

  return { items, partial };
}

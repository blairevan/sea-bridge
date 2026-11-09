import { realpathSync } from "node:fs";
import path from "node:path";

const SAFE_SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AllowedAntigravityProject {
  id: string;
  name: string;
  rootPath: string;
}

/** Validate that a sessionId is a safe identifier without path traversal or NUL bytes. */
export function isValidAntigravitySessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.includes("\0") || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    return false;
  }
  return SAFE_SESSION_ID_REGEX.test(sessionId);
}

/** Validate that a desktop conversation_id is a strict UUID before resolving brain/<id> paths. */
export function isValidDesktopConversationId(conversationId: string): boolean {
  return UUID_REGEX.test(conversationId);
}

/** Canonicalize and verify an allowed project root path. */
export function resolveAllowedProjectRoot(rawPath: string): string {
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("antigravity_invalid_project_path");
  }
  return realpathSync(rawPath);
}

/** Verify that a target file or directory resolves strictly inside an expected base directory. */
export function resolveInsideDirectory(baseDir: string, relativeTarget: string): string | null {
  if (!baseDir || !relativeTarget || relativeTarget.includes("\0")) return null;
  try {
    const canonicalBase = realpathSync(baseDir);
    const candidate = path.resolve(canonicalBase, relativeTarget);
    const canonicalTarget = realpathSync(candidate);
    if (canonicalTarget === canonicalBase || canonicalTarget.startsWith(canonicalBase + path.sep)) {
      return canonicalTarget;
    }
    return null;
  } catch {
    return null;
  }
}

/** Match a workspace URI (e.g. "file:///opt/app/aitools/sea-bridge") against configured allowed projects. */
export function matchWorkspaceUriToProject(
  workspaceUrisJson: string | null | undefined,
  allowedProjects: readonly AllowedAntigravityProject[]
): { projectId: string | null; cwd: string | null } {
  if (!workspaceUrisJson) return { projectId: null, cwd: null };
  let uris: unknown;
  try {
    uris = JSON.parse(workspaceUrisJson);
  } catch {
    return { projectId: null, cwd: null };
  }
  if (!Array.isArray(uris)) return { projectId: null, cwd: null };

  for (const item of uris) {
    if (typeof item !== "string") continue;
    let fsPath = item;
    if (item.startsWith("file://")) {
      try {
        fsPath = decodeURIComponent(new URL(item).pathname);
      } catch {
        continue;
      }
    }
    let canonicalPath = fsPath;
    try {
      canonicalPath = realpathSync(fsPath);
    } catch {
      // Keep raw decoded path if directory no longer exists on disk
    }
    for (const proj of allowedProjects) {
      let canonicalRoot = proj.rootPath;
      try {
        canonicalRoot = realpathSync(proj.rootPath);
      } catch {
        // ignore
      }
      if (canonicalPath === canonicalRoot || canonicalPath.startsWith(canonicalRoot + path.sep)) {
        return { projectId: proj.id, cwd: canonicalPath };
      }
    }
    return { projectId: null, cwd: canonicalPath };
  }
  return { projectId: null, cwd: null };
}

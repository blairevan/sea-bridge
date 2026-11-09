import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveAllowedProjectRoot, type AllowedAntigravityProject } from "./policy.ts";

export interface AntigravityConfig {
  enabled: boolean;
  writeEnabled: boolean;
  cliPath: string;
  geminiDir: string;
  appDataDir: string;
  desktopReadEnabled: boolean;
  desktopAppDataDir: string;
  maxActive: number;
  approvalTimeoutMs: number;
  externalSessionsEnabled: boolean;
  allowedProjects: AllowedAntigravityProject[];
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

function parseBool(raw: string | undefined, fallback: boolean, name: string): boolean {
  const val = raw?.trim().toLowerCase();
  if (!val) return fallback;
  if (["1", "true", "yes", "on"].includes(val)) return true;
  if (["0", "false", "no", "off"].includes(val)) return false;
  throw new Error(`${name} must be a boolean`);
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const val = raw?.trim();
  if (!val) return fallback;
  const parsed = Number.parseInt(val, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseAllowedProjects(rawJson: string | undefined): AllowedAntigravityProject[] {
  if (!rawJson || !rawJson.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("SEA_BRIDGE_ANTIGRAVITY_PROJECTS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEA_BRIDGE_ANTIGRAVITY_PROJECTS_JSON must be an array");
  }
  const projects: AllowedAntigravityProject[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : id;
    const rawRoot = typeof rec.rootPath === "string" ? rec.rootPath.trim() : "";
    if (!id || !rawRoot) continue;
    const rootPath = resolveAllowedProjectRoot(expandHome(rawRoot));
    projects.push({ id, name: name || id, rootPath });
  }
  return projects;
}

/** Load and validate Antigravity configuration from environment variables. */
export function loadAntigravityConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): AntigravityConfig {
  const enabled = parseBool(env.SEA_BRIDGE_ANTIGRAVITY_ENABLED, false, "SEA_BRIDGE_ANTIGRAVITY_ENABLED");
  const writeEnabled = parseBool(env.SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED, false, "SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED");
  if (writeEnabled && !enabled) {
    throw new Error("SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED requires SEA_BRIDGE_ANTIGRAVITY_ENABLED");
  }
  const desktopReadEnabled = enabled
    ? parseBool(env.SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED, true, "SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED")
    : false;
  const externalSessionsEnabled = parseBool(
    env.SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED,
    false,
    "SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED"
  );
  const cliPath = expandHome(env.SEA_BRIDGE_ANTIGRAVITY_CLI_PATH?.trim() || "/Users/zhuhaijun/.local/bin/agy");
  const geminiDir = expandHome(env.SEA_BRIDGE_ANTIGRAVITY_GEMINI_DIR?.trim() || "~/.gemini");
  const appDataDir = env.SEA_BRIDGE_ANTIGRAVITY_APP_DATA_DIR?.trim() || "antigravity-cli";
  const desktopAppDataDir = expandHome(
    env.SEA_BRIDGE_ANTIGRAVITY_DESKTOP_APP_DATA_DIR?.trim() || "~/.gemini/antigravity"
  );

  return {
    enabled,
    writeEnabled,
    cliPath,
    geminiDir,
    appDataDir,
    desktopReadEnabled,
    desktopAppDataDir,
    maxActive: parsePositiveInt(env.SEA_BRIDGE_ANTIGRAVITY_MAX_ACTIVE, 1, "SEA_BRIDGE_ANTIGRAVITY_MAX_ACTIVE"),
    approvalTimeoutMs: parsePositiveInt(
      env.SEA_BRIDGE_ANTIGRAVITY_APPROVAL_TIMEOUT_MS,
      300_000,
      "SEA_BRIDGE_ANTIGRAVITY_APPROVAL_TIMEOUT_MS"
    ),
    externalSessionsEnabled,
    allowedProjects: parseAllowedProjects(env.SEA_BRIDGE_ANTIGRAVITY_PROJECTS_JSON),
  };
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type DesktopAgentMode = "full-access" | "guardian-approvals" | "auto" | "read-only";

export type ApprovalsReviewerType = "user" | "auto_review" | "guardian_subagent";

export interface ResolvedDesktopPermissions {
  mode: DesktopAgentMode;
  source: "atom_state_selection" | "atom_state_agent_mode" | "config_toml" | "default";
  threadStart: {
    sandbox: "danger-full-access" | "workspace-write" | "read-only";
    approvalPolicy: "never" | "on-request";
    approvalsReviewer: ApprovalsReviewerType;
  };
  turnStart: (cwd: string) => {
    sandboxPolicy:
      | { type: "dangerFullAccess" }
      | { type: "readOnly"; networkAccess: boolean }
      | {
          type: "workspaceWrite";
          writableRoots: string[];
          networkAccess: boolean;
          excludeTmpdirEnvVar: boolean;
          excludeSlashTmp: boolean;
        };
    approvalPolicy: "never" | "on-request";
    approvalsReviewer: ApprovalsReviewerType;
  };
}

export function parseModeFromSelection(selection: unknown): DesktopAgentMode | null {
  if (!selection || typeof selection !== "object") return null;
  const obj = selection as Record<string, unknown>;
  if (obj.kind === "agent-mode" && typeof obj.agentMode === "string") {
    const mode = obj.agentMode;
    if (mode === "full-access" || mode === "guardian-approvals" || mode === "auto" || mode === "read-only") {
      return mode;
    }
  }
  if (obj.kind === "profile" && typeof obj.profileId === "string") {
    const id = obj.profileId;
    if (id === ":danger-full-access") return "full-access";
    if (id === ":read-only") return "read-only";
    if (id === ":workspace") return "auto";
  }
  return null;
}

export function parseModeFromAgentModeByHost(value: unknown): DesktopAgentMode | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const local = obj.local;
  if (local === "full-access" || local === "guardian-approvals" || local === "auto" || local === "read-only") {
    return local;
  }
  return null;
}

export function parseModeFromConfigToml(content: string): {
  mode: DesktopAgentMode;
  reviewer?: ApprovalsReviewerType;
} | null {
  const sandboxMatch = content.match(/sandbox_mode\s*=\s*["']([^"']+)["']/);
  const approvalMatch = content.match(/approval_policy\s*=\s*["']([^"']+)["']/);
  const reviewerMatch = content.match(/approvals_reviewer\s*=\s*["']([^"']+)["']/);

  const sandbox = sandboxMatch?.[1];
  const approval = approvalMatch?.[1];
  const reviewerRaw = reviewerMatch?.[1];
  const reviewer: ApprovalsReviewerType | undefined =
    reviewerRaw === "guardian_subagent" || reviewerRaw === "auto_review" || reviewerRaw === "user"
      ? reviewerRaw
      : undefined;

  if (sandbox === "danger-full-access" && approval === "never") {
    return { mode: "full-access", reviewer: reviewer ?? "user" };
  }
  if (reviewer === "guardian_subagent") {
    return { mode: "guardian-approvals", reviewer: "guardian_subagent" };
  }
  if (sandbox === "read-only") {
    return { mode: "read-only", reviewer: reviewer ?? "user" };
  }
  if (sandbox === "workspace-write" || approval === "on-request") {
    return { mode: "auto", reviewer: reviewer ?? "user" };
  }
  return null;
}

export function buildPermissionsForMode(
  mode: DesktopAgentMode,
  source: ResolvedDesktopPermissions["source"] = "default",
  reviewerOverride?: ApprovalsReviewerType,
): ResolvedDesktopPermissions {
  switch (mode) {
    case "full-access":
      return {
        mode,
        source,
        threadStart: {
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          approvalsReviewer: reviewerOverride ?? "user",
        },
        turnStart: () => ({
          sandboxPolicy: { type: "dangerFullAccess" },
          approvalPolicy: "never",
          approvalsReviewer: reviewerOverride ?? "user",
        }),
      };
    case "guardian-approvals":
      return {
        mode,
        source,
        threadStart: {
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: reviewerOverride ?? "guardian_subagent",
        },
        turnStart: (cwd: string) => ({
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: cwd ? [cwd] : [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          approvalPolicy: "on-request",
          approvalsReviewer: reviewerOverride ?? "guardian_subagent",
        }),
      };
    case "auto":
      return {
        mode,
        source,
        threadStart: {
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: reviewerOverride ?? "user",
        },
        turnStart: (cwd: string) => ({
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: cwd ? [cwd] : [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          approvalPolicy: "on-request",
          approvalsReviewer: reviewerOverride ?? "user",
        }),
      };
    case "read-only":
      return {
        mode,
        source,
        threadStart: {
          sandbox: "read-only",
          approvalPolicy: "on-request",
          approvalsReviewer: reviewerOverride ?? "user",
        },
        turnStart: () => ({
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          approvalPolicy: "on-request",
          approvalsReviewer: reviewerOverride ?? "user",
        }),
      };
  }
}

export function resolveDesktopPermissions(codexHome?: string): ResolvedDesktopPermissions {
  const home = codexHome ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
  const globalStatePath = resolve(home, ".codex-global-state.json");
  const configTomlPath = resolve(home, "config.toml");

  try {
    if (existsSync(globalStatePath)) {
      const raw = readFileSync(globalStatePath, "utf8");
      const data = JSON.parse(raw);
      const atomState = data?.["electron-persisted-atom-state"];
      if (atomState && typeof atomState === "object") {
        const selectionMode = parseModeFromSelection(atomState["permission-selection-by-host-id:local"]);
        if (selectionMode) {
          return buildPermissionsForMode(selectionMode, "atom_state_selection");
        }
        const hostMode = parseModeFromAgentModeByHost(atomState["agent-mode-by-host-id"]);
        if (hostMode) {
          return buildPermissionsForMode(hostMode, "atom_state_agent_mode");
        }
      }
    }
  } catch {
    // ignore read/parse error and fallback
  }

  try {
    if (existsSync(configTomlPath)) {
      const raw = readFileSync(configTomlPath, "utf8");
      const parsed = parseModeFromConfigToml(raw);
      if (parsed) {
        return buildPermissionsForMode(parsed.mode, "config_toml", parsed.reviewer);
      }
    }
  } catch {
    // ignore read/parse error and fallback
  }

  return buildPermissionsForMode("full-access", "default");
}


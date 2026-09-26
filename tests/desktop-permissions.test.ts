import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPermissionsForMode,
  parseModeFromAgentModeByHost,
  parseModeFromConfigToml,
  parseModeFromSelection,
  resolveDesktopPermissions,
} from "../src/desktop/desktop-permissions.ts";

describe("desktop-permissions", () => {
  describe("parseModeFromSelection", () => {
    test("handles agent-mode selection shapes", () => {
      expect(parseModeFromSelection({ kind: "agent-mode", agentMode: "full-access" })).toBe("full-access");
      expect(parseModeFromSelection({ kind: "agent-mode", agentMode: "auto" })).toBe("auto");
      expect(parseModeFromSelection({ kind: "agent-mode", agentMode: "guardian-approvals" })).toBe("guardian-approvals");
      expect(parseModeFromSelection({ kind: "agent-mode", agentMode: "read-only" })).toBe("read-only");
    });

    test("handles profile shortcuts", () => {
      expect(parseModeFromSelection({ kind: "profile", profileId: ":danger-full-access" })).toBe("full-access");
      expect(parseModeFromSelection({ kind: "profile", profileId: ":workspace" })).toBe("auto");
      expect(parseModeFromSelection({ kind: "profile", profileId: ":read-only" })).toBe("read-only");
      expect(parseModeFromSelection({ kind: "profile", profileId: "custom-profile" })).toBeNull();
    });

    test("returns null for malformed or missing input", () => {
      expect(parseModeFromSelection(null)).toBeNull();
      expect(parseModeFromSelection(undefined)).toBeNull();
      expect(parseModeFromSelection({})).toBeNull();
      expect(parseModeFromSelection({ kind: "unknown" })).toBeNull();
    });
  });

  describe("parseModeFromAgentModeByHost", () => {
    test("reads local host agent mode", () => {
      expect(parseModeFromAgentModeByHost({ local: "full-access" })).toBe("full-access");
      expect(parseModeFromAgentModeByHost({ local: "auto" })).toBe("auto");
      expect(parseModeFromAgentModeByHost({ local: "guardian-approvals" })).toBe("guardian-approvals");
      expect(parseModeFromAgentModeByHost({ local: "read-only" })).toBe("read-only");
    });

    test("returns null for missing or invalid values", () => {
      expect(parseModeFromAgentModeByHost(null)).toBeNull();
      expect(parseModeFromAgentModeByHost({})).toBeNull();
      expect(parseModeFromAgentModeByHost({ local: "invalid" })).toBeNull();
    });
  });

  describe("parseModeFromConfigToml", () => {
    test("identifies danger-full-access with never approval policy", () => {
      const toml = `
approval_policy = "never"
sandbox_mode = "danger-full-access"
`;
      expect(parseModeFromConfigToml(toml)).toEqual({ mode: "full-access", reviewer: "user" });
    });

    test("identifies guardian_subagent reviewer", () => {
      const toml = `
approvals_reviewer = "guardian_subagent"
approval_policy = "on-request"
`;
      expect(parseModeFromConfigToml(toml)).toEqual({ mode: "guardian-approvals", reviewer: "guardian_subagent" });
    });

    test("identifies read-only sandbox mode", () => {
      const toml = `
sandbox_mode = "read-only"
`;
      expect(parseModeFromConfigToml(toml)).toEqual({ mode: "read-only", reviewer: "user" });
    });

    test("identifies workspace-write or on-request as auto", () => {
      const toml = `
sandbox_mode = "workspace-write"
approval_policy = "on-request"
`;
      expect(parseModeFromConfigToml(toml)).toEqual({ mode: "auto", reviewer: "user" });
    });
  });

  describe("buildPermissionsForMode", () => {
    test("builds correct structure for full-access", () => {
      const perms = buildPermissionsForMode("full-access", "atom_state_selection");
      expect(perms.mode).toBe("full-access");
      expect(perms.source).toBe("atom_state_selection");
      expect(perms.threadStart).toEqual({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
      });
      expect(perms.turnStart("/some/dir")).toEqual({
        sandboxPolicy: { type: "dangerFullAccess" },
        approvalPolicy: "never",
        approvalsReviewer: "user",
      });
    });

    test("builds correct structure for auto (ask on request)", () => {
      const perms = buildPermissionsForMode("auto", "atom_state_selection");
      expect(perms.mode).toBe("auto");
      expect(perms.threadStart).toEqual({
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      });
      expect(perms.turnStart("/opt/app/aining")).toEqual({
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/opt/app/aining"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      });
    });

    test("builds correct structure for guardian-approvals", () => {
      const perms = buildPermissionsForMode("guardian-approvals", "atom_state_selection");
      expect(perms.mode).toBe("guardian-approvals");
      expect(perms.threadStart).toEqual({
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
      });
      expect(perms.turnStart("/workspace")).toEqual({
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
      });
    });

    test("builds correct structure for read-only", () => {
      const perms = buildPermissionsForMode("read-only", "atom_state_selection");
      expect(perms.mode).toBe("read-only");
      expect(perms.threadStart).toEqual({
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      });
      expect(perms.turnStart("/workspace")).toEqual({
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      });
    });
  });

  describe("resolveDesktopPermissions integration with directory", () => {
    const testDir = join(tmpdir(), `codex-perm-test-${Date.now()}`);

    test("resolves from .codex-global-state.json permission-selection", () => {
      mkdirSync(testDir, { recursive: true });
      try {
        writeFileSync(
          join(testDir, ".codex-global-state.json"),
          JSON.stringify({
            "electron-persisted-atom-state": {
              "permission-selection-by-host-id:local": {
                kind: "agent-mode",
                agentMode: "auto",
              },
            },
          }),
        );

        const res = resolveDesktopPermissions(testDir);
        expect(res.mode).toBe("auto");
        expect(res.source).toBe("atom_state_selection");
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("falls back to agent-mode-by-host-id if selection is absent", () => {
      mkdirSync(testDir, { recursive: true });
      try {
        writeFileSync(
          join(testDir, ".codex-global-state.json"),
          JSON.stringify({
            "electron-persisted-atom-state": {
              "agent-mode-by-host-id": {
                local: "read-only",
              },
            },
          }),
        );

        const res = resolveDesktopPermissions(testDir);
        expect(res.mode).toBe("read-only");
        expect(res.source).toBe("atom_state_agent_mode");
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("falls back to config.toml if global-state is missing", () => {
      mkdirSync(testDir, { recursive: true });
      try {
        writeFileSync(
          join(testDir, "config.toml"),
          `approval_policy = "never"\nsandbox_mode = "danger-full-access"\n`,
        );

        const res = resolveDesktopPermissions(testDir);
        expect(res.mode).toBe("full-access");
        expect(res.source).toBe("config_toml");
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("falls back to default full-access if neither file exists", () => {
      mkdirSync(testDir, { recursive: true });
      try {
        const res = resolveDesktopPermissions(testDir);
        expect(res.mode).toBe("full-access");
        expect(res.source).toBe("default");
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});


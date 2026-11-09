import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AntigravityApprovalBridge } from "../src/antigravity/approval-bridge.ts";
import { AntigravityStore, migrateAntigravityBridgeTables } from "../src/antigravity/store.ts";

describe("AntigravityApprovalBridge", () => {
  test("enforces single decision, validates optionId, and rejects duplicate or expired clicks", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const bridge = new AntigravityApprovalBridge(store, { timeoutMs: 5000 });

      const { approval, promise } = bridge.requestPermission({
        sessionId: "sess-1",
        executionId: "exec-1",
        processGeneration: 1,
        rpcRequestId: "1",
        request: {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-1", name: "run_command", title: "echo hi" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        now: 1000,
      });

      expect(store.listPendingApprovals("sess-1")).toHaveLength(1);

      // Invalid option is rejected without consuming pending approval
      expect(
        bridge.decide({
          sessionId: "sess-1",
          approvalId: approval.id,
          optionId: "nonexistent",
          decidedBy: "web:dev-1",
          now: 1100,
        })
      ).toEqual({ status: "invalid_option" });

      // Valid option resolves the RPC promise with exact optionId
      const decision = bridge.decide({
        sessionId: "sess-1",
        approvalId: approval.id,
        optionId: "allow",
        decidedBy: "web:dev-1",
        now: 1200,
      });
      expect(decision.status).toBe("decided");
      expect(await promise).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

      // Duplicate click returns already_decided
      const secondClick = bridge.decide({
        sessionId: "sess-1",
        approvalId: approval.id,
        optionId: "deny",
        decidedBy: "web:dev-1",
        now: 1300,
      });
      expect(secondClick.status).toBe("already_decided");
      expect(store.listPendingApprovals("sess-1")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("auto-cancels on timeout and settles pending approvals on session cancellation", async () => {
    const db = new Database(":memory:");
    try {
      migrateAntigravityBridgeTables(db);
      const store = new AntigravityStore(db);
      const timedOutExecs: string[] = [];
      const bridge = new AntigravityApprovalBridge(store, {
        timeoutMs: 20,
        onApprovalTimeout: (_sessionId, executionId) => timedOutExecs.push(executionId),
      });

      const { approval: ap1, promise: p1 } = bridge.requestPermission({
        sessionId: "sess-timeout",
        executionId: "exec-timeout",
        processGeneration: 1,
        rpcRequestId: "1",
        request: {
          sessionId: "sess-timeout",
          toolCall: { toolCallId: "tc-t", name: "run_command" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      expect(await p1).toEqual({ outcome: { outcome: "cancelled" } });
      expect(store.getApproval(ap1.id)?.status).toBe("expired");
      expect(timedOutExecs).toEqual(["exec-timeout"]);

      // Test explicit session cancellation
      const bridge2 = new AntigravityApprovalBridge(store, { timeoutMs: 10_000 });
      const { approval: ap2, promise: p2 } = bridge2.requestPermission({
        sessionId: "sess-cancel",
        executionId: "exec-cancel",
        processGeneration: 2,
        rpcRequestId: "2",
        request: {
          sessionId: "sess-cancel",
          toolCall: { toolCallId: "tc-c", name: "run_command" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });

      expect(bridge2.cancelPendingForSession("sess-cancel", "user_stop")).toBe(1);
      expect(await p2).toEqual({ outcome: { outcome: "cancelled" } });
      expect(store.getApproval(ap2.id)?.status).toBe("cancelled");
    } finally {
      db.close();
    }
  });
});

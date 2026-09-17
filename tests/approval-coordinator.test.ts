import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { ApprovalCoordinator } from "../src/desktop/approval-coordinator.ts";
import type { Logger } from "../src/logger.ts";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeTelegram {
  buttons: any[][] | undefined;
  edits = 0;
  async sendMessage(_chatId: string, _text: string, buttons?: any[][]) {
    this.buttons = buttons;
    return { message_id: 42, chat: { id: 1, type: "private" } };
  }
  async editMessageReplyMarkup() { this.edits += 1; return true; }
}

describe("ApprovalCoordinator", () => {
  test("resolves one Telegram callback into one hook decision", async () => {
    const state = new StateDb(":memory:");
    const telegram = new FakeTelegram();
    const approvals = new ApprovalCoordinator(state, telegram as any, "1", 1000, logger);
    const pending = approvals.request("event-1", {
      session_id: "session-1",
      turn_id: "turn-1",
      hook_event_name: "PermissionRequest",
      tool_name: "exec_command",
      tool_input: { cmd: "git status" },
    });
    await Bun.sleep(0);

    const callbackData = telegram.buttons?.[0]?.[0]?.callback_data as string;
    expect(callbackData.startsWith("ap:")).toBe(true);
    const token = callbackData.split(":")[1]!;
    expect(await approvals.resolveCallback(token, "allow")).toBe("resolved");
    const resolution = await pending;
    expect(resolution?.decision).toBe("allow");
    expect(resolution?.approvalId).toBeTruthy();
    approvals.markDelivered(resolution!.approvalId);
    const delivered = state.db.query("SELECT status FROM pending_approvals WHERE id=?").get(resolution!.approvalId) as { status: string };
    expect(delivered.status).toBe("delivered");
    expect(await approvals.resolveCallback(token, "deny")).toBe("stale");
    expect(telegram.edits).toBe(1);
    state.close();
  });

  test("expires without guessing a decision", async () => {
    const state = new StateDb(":memory:");
    const telegram = new FakeTelegram();
    const approvals = new ApprovalCoordinator(state, telegram as any, "1", 5, logger);
    const result = await approvals.request("event-2", {
      session_id: "session-1",
      turn_id: "turn-1",
      hook_event_name: "PermissionRequest",
      tool_name: "exec_command",
      tool_input: {},
    });
    expect(result).toBeNull();
    const row = state.db.query("SELECT status,decision FROM pending_approvals WHERE event_hash='event-2'").get() as any;
    expect(row.status).toBe("expired");
    expect(row.decision).toBeNull();
    state.close();
  });
});

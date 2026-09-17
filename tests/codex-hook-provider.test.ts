import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { ContinuationQueue } from "../src/state/continuation-queue.ts";
import { SessionStateStore } from "../src/desktop/session-state.ts";
import { CodexHookProvider } from "../src/desktop/providers/codex-hook.ts";
import type { Logger } from "../src/logger.ts";

const logger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
};

function envelope(event: Record<string, unknown>) {
  return {
    protocolVersion: 1 as const,
    invocationId: crypto.randomUUID(),
    sentAt: Date.now(),
    event: event as any,
  };
}

describe("CodexHookProvider", () => {
  test("Stop claims queued continuation for the same observed active turn", async () => {
    const state = new StateDb(":memory:");
    const sessions = new SessionStateStore(state);
    const queue = new ContinuationQueue(state);
    sessions.observeEvent({ session_id: "s1", turn_id: "t1", hook_event_name: "PreToolUse" });
    const queued = queue.enqueue("s1", "continue from telegram", 1);

    const provider = new CodexHookProvider(
      sessions,
      queue,
      { request: async () => null } as any,
      logger,
      { activeSessionTtlMs: 60_000, requireFreshTranscript: false },
    );

    const result = await provider.handle(envelope({
      session_id: "s1",
      turn_id: "t1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    }));

    expect(result.output).toEqual({ decision: "block", reason: "continue from telegram" });
    result.onDelivered?.();
    const row = state.db.query("SELECT status FROM continuation_queue WHERE id=?").get(queued.id) as { status: string };
    expect(row.status).toBe("consumed");
    state.close();
  });

  test("Stop does not consume queue when the turn was not observed active", async () => {
    const state = new StateDb(":memory:");
    const sessions = new SessionStateStore(state);
    const queue = new ContinuationQueue(state);
    queue.enqueue("s1", "must not leak", 2);

    const provider = new CodexHookProvider(
      sessions,
      queue,
      { request: async () => null } as any,
      logger,
      { activeSessionTtlMs: 60_000, requireFreshTranscript: false },
    );
    const result = await provider.handle(envelope({ session_id: "s1", turn_id: "t1", hook_event_name: "Stop" }));
    expect(result.output).toBeNull();
    expect(queue.pendingCount("s1")).toBe(1);
    state.close();
  });

  test("rejects replay-like Stop when transcript freshness cannot be proven", async () => {
    const state = new StateDb(":memory:");
    const sessions = new SessionStateStore(state);
    const queue = new ContinuationQueue(state);
    const dir = mkdtempSync(join(tmpdir(), "sea-bridge-transcript-"));
    const transcript = join(dir, "old.jsonl");
    writeFileSync(transcript, "{}\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(transcript, old, old);
    sessions.observeEvent({ session_id: "s1", turn_id: "t1", hook_event_name: "PreToolUse", transcript_path: transcript });
    queue.enqueue("s1", "do not consume stale", 3);

    const provider = new CodexHookProvider(
      sessions,
      queue,
      { request: async () => null } as any,
      logger,
      { activeSessionTtlMs: 1_000, requireFreshTranscript: true },
    );
    const result = await provider.handle(envelope({
      session_id: "s1",
      turn_id: "t1",
      hook_event_name: "Stop",
      transcript_path: transcript,
    }));
    expect(result.output).toBeNull();
    expect(queue.pendingCount("s1")).toBe(1);
    rmSync(dir, { recursive: true, force: true });
    state.close();
  });

  test("PermissionRequest emits official allow shape only after same-turn freshness proof", async () => {
    const state = new StateDb(":memory:");
    const sessions = new SessionStateStore(state);
    const queue = new ContinuationQueue(state);
    sessions.observeEvent({ session_id: "s1", turn_id: "t1", hook_event_name: "PreToolUse" });

    const provider = new CodexHookProvider(
      sessions,
      queue,
      { request: async () => ({ approvalId: "approval-1", decision: "allow" }), markDelivered() {}, markDeliveryFailed() {} } as any,
      logger,
      { activeSessionTtlMs: 60_000, requireFreshTranscript: false },
    );
    const result = await provider.handle(envelope({
      session_id: "s1",
      turn_id: "t1",
      hook_event_name: "PermissionRequest",
      tool_name: "exec_command",
      tool_input: { cmd: "git status" },
    }));
    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    state.close();
  });
});

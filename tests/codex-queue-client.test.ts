import { describe, expect, test } from "bun:test";
import { ProcessCodexQueueClient } from "../src/desktop/codex-queue-client.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ProcessCodexQueueClient", () => {
  test("keeps the native queue receipt and correlates diagnostics without logging content", async () => {
    const thread = "01a0ff95-b6cf-7250-bcd0-f937a498ec05";
    const queueItemId = "01a0ff96-d2e0-7a12-8430-5c5c5b904c38";
    const observed: unknown[] = [];
    const client = new ProcessCodexQueueClient("/codex", async () => ({
      exitCode: 0, signal: null, stderr: "private stderr", stdout: `Queued message ${queueItemId} for thread ${thread}.\n`,
    }), 15000, {
      submitted: (trace: unknown) => { observed.push(trace); },
      settled: (trace: unknown, result: unknown, details: unknown) => { observed.push({ trace, result, details }); },
    });
    expect(await client.queue(thread, "private prompt", { source: "web" })).toMatchObject({ status: "delivered", queueItemId });
    expect(observed).toHaveLength(2);
    expect(JSON.stringify(observed)).not.toContain("private prompt");
    expect(JSON.stringify(observed)).not.toContain("private stderr");
    expect(observed[0]).toMatchObject({ threadId: thread, source: "web", messageLength: 14 });
  });

  test("does not accept another thread's receipt or let diagnostics change delivery", async () => {
    const client = new ProcessCodexQueueClient("/codex", async () => ({
      exitCode: 0, signal: null, stderr: "", stdout: "Queued message 01a0ff96-d2e0-7a12-8430-5c5c5b904c38 for thread another-thread.\n",
    }), 15000, {
      submitted: () => { throw new Error("diagnostics unavailable"); },
      settled: () => { throw new Error("diagnostics unavailable"); },
    });
    expect(await client.queue("thread", "prompt")).toEqual({ status: "delivered", exitCode: 0 });
  });

  test("terminates a stalled queue subprocess and preserves an unknown outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-deadline-")); const path = join(root, "queue");
    writeFileSync(path, `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    try {
      const client = new ProcessCodexQueueClient(path, undefined, 30);
      expect(await client.queue("thread", "prompt")).toMatchObject({ status: "delivery_unknown", exitCode: null, errorCode: "codex_queue_timeout" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("passes CODEX_HOME to the queue subprocess and fails closed when admission is disabled", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let calls = 0;
    const client = new ProcessCodexQueueClient("/codex", async (_command, _args, _timeout, env) => {
      calls += 1; capturedEnv = env;
      return { exitCode: 0, signal: null, stderr: "" };
    }, 15_000, undefined, "/target/codex", () => true);
    expect(await client.queue("thread", "hello")).toMatchObject({ status: "delivered" });
    expect(capturedEnv?.CODEX_HOME).toBe("/target/codex");

    const blocked = new ProcessCodexQueueClient("/codex", async () => {
      calls += 1; return { exitCode: 0, signal: null, stderr: "" };
    }, 15_000, undefined, "/target/codex", () => false);
    expect(await blocked.queue("thread", "hello")).toEqual({
      status: "failed", exitCode: null, errorCode: "codex_environment_reinitialize_required",
    });
    expect(calls).toBe(1);
  });

  test("passes thread and message as separate arguments", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const client = new ProcessCodexQueueClient("/codex", async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, signal: null, stderr: "" };
    });

    await client.queue("thread-a", "[Telegram reply]\\nhello");
    expect(calls).toEqual([{
      command: "/codex",
      args: ["queue", "--thread", "thread-a", "--message", "[Telegram reply]\\nhello"],
    }]);
  });
});

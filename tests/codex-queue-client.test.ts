import { describe, expect, test } from "bun:test";
import { ProcessCodexQueueClient } from "../src/desktop/codex-queue-client.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ProcessCodexQueueClient", () => {
  test("terminates a stalled queue subprocess and preserves an unknown outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "queue-deadline-")); const path = join(root, "queue");
    writeFileSync(path, `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    try {
      const client = new ProcessCodexQueueClient(path, undefined, 30);
      expect(await client.queue("thread", "prompt")).toMatchObject({ status: "delivery_unknown", exitCode: null, errorCode: "codex_queue_timeout" });
    } finally { rmSync(root, { recursive: true, force: true }); }
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

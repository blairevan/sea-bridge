import { describe, expect, test } from "bun:test";
import { ProcessCodexQueueClient } from "../src/desktop/codex-queue-client.ts";

describe("ProcessCodexQueueClient", () => {
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

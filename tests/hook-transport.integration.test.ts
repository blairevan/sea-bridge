import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { ContinuationQueue } from "../src/state/continuation-queue.ts";
import { SessionStateStore } from "../src/desktop/session-state.ts";
import { CodexHookProvider } from "../src/desktop/providers/codex-hook.ts";
import { HookServer } from "../src/desktop/providers/hook-server.ts";
import type { Logger } from "../src/logger.ts";

const dirs: string[] = [];
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codex hook transport", () => {
  test("python wrapper receives Stop continuation over unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sea-bridge-"));
    dirs.push(dir);
    const socketPath = join(dir, "hook.sock");
    const state = new StateDb(":memory:");
    const sessions = new SessionStateStore(state);
    const queue = new ContinuationQueue(state);
    sessions.observeEvent({ session_id: "desktop-session", turn_id: "turn-1", hook_event_name: "PreToolUse" });
    queue.enqueue("desktop-session", "continue from telegram", 51);

    const provider = new CodexHookProvider(
      sessions,
      queue,
      { request: async () => null } as any,
      logger,
      { activeSessionTtlMs: 60_000, requireFreshTranscript: false },
    );
    const server = new HookServer(socketPath, provider, logger);
    await server.start();

    const proc = Bun.spawn(["python3", "scripts/codex-hook-bridge.py"], {
      cwd: process.cwd(),
      env: { ...process.env, SEA_BRIDGE_HOOK_SOCKET: socketPath, SEA_BRIDGE_HOOK_TIMEOUT_SECONDS: "2" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({
      session_id: "desktop-session",
      turn_id: "turn-1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      cwd: "/tmp",
    }));
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ decision: "block", reason: "continue from telegram" });
    expect(queue.pendingCount("desktop-session")).toBe(0);

    await server.stop();
    state.close();
  });

  test("python wrapper fails open when Sea-Bridge is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sea-bridge-"));
    dirs.push(dir);
    const socketPath = join(dir, "missing.sock");
    const proc = Bun.spawn(["python3", "scripts/codex-hook-bridge.py"], {
      cwd: process.cwd(),
      env: { ...process.env, SEA_BRIDGE_HOOK_SOCKET: socketPath, SEA_BRIDGE_HOOK_TIMEOUT_SECONDS: "0.1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({ session_id: "s", turn_id: "t", hook_event_name: "Stop" }));
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");
  });
});

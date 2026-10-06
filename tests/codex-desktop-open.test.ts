import { test, expect } from "bun:test";
import { CodexWebSource } from "../src/web/sources/codex.ts";
import { openCodexDesktopThread } from "../src/desktop/codex-desktop-opener.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const id = "11111111-1111-4111-8111-111111111111";
/** Build a source whose delivery paths fail if navigation accidentally invokes them. */
function fixture(openDesktop?: (id: string) => Promise<void>) {
  return new CodexWebSource({
    ...(openDesktop ? { openDesktop } : {}),
    threads: { listActive: () => [{ id, title: "fixture", updatedAtMs: 1, rolloutPath: "/unused" }] },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn(): Promise<never> { throw new Error("unexpected turn"); } },
    queue: { async queue(): Promise<never> { throw new Error("unexpected queue"); } },
    sessionRoots: [], pathExists: () => true, queueUsable: true, pendingApproval: () => false,
  });
}

test("desktop navigation validates identity and does not deliver another prompt", async () => {
  const calls: string[] = []; const source = fixture(async (value) => { calls.push(value); });
  await expect(source.openDesktop("bad?prompt=hello")).rejects.toThrow("invalid_session_id");
  await expect(source.openDesktop("22222222-2222-4222-8222-222222222222")).rejects.toThrow("session_missing");
  await source.openDesktop(id);
  expect(calls).toEqual([id]);
  await expect(source.openDesktop(id)).rejects.toThrow("desktop_open_busy");
  expect(calls).toEqual([id]);
});

test("desktop navigation exposes availability and propagates launch failures", async () => {
  expect(fixture().capabilities().desktopOpenEnabled).toBe(false);
  await expect(fixture().openDesktop(id)).rejects.toThrow("desktop_open_unavailable");
  const source = fixture(async () => { throw new Error("desktop_open_failed"); });
  expect(source.capabilities().desktopOpenEnabled).toBe(true);
  await expect(source.openDesktop(id)).rejects.toThrow("desktop_open_failed");
  await expect(openCodexDesktopThread("--args")).rejects.toThrow("invalid_session_id");
});

test("desktop navigation rejects overlapping requests", async () => {
  let release: (() => void) | undefined;
  const source = fixture(() => new Promise<void>((resolve) => { release = resolve; }));
  const opening = source.openDesktop(id);
  await expect(source.openDesktop(id)).rejects.toThrow("desktop_open_busy");
  release?.(); await opening;
});

test("automatic recovery requires native idle evidence and excludes active hooks, approvals and stale catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-recovery-"));
  const path = join(root, "rollout.jsonl");
  let pendingApproval = false;
  let hookActive = false;
  let health: "ready" | "stale" = "ready";
  const source = new CodexWebSource({
    threads: { listActive: () => [], getThread: () => ({ id, title: "fixture", updatedAtMs: 1, rolloutPath: path }) },
    appServer: { async listProjects() { return []; }, async listModels() { return []; }, async startThreadAndTurn(): Promise<never> { throw new Error("unexpected turn"); } },
    queue: { async queue(): Promise<never> { throw new Error("unexpected queue"); } },
    sessionRoots: [root], pathExists: () => true, queueUsable: true,
    pendingApproval: () => pendingApproval, catalogHealth: () => health,
    activity: () => hookActive ? { state: "active", turnId: "turn" } : null,
  });
  try {
    expect(await source.isDesktopRecoveryIdle(id)).toBe(false);
    await Bun.write(path, JSON.stringify({ type: "event_msg", timestamp: "2026-10-06T00:00:00Z", payload: { type: "task_complete", turn_id: "turn" } }) + "\n");
    expect(await source.isDesktopRecoveryIdle(id)).toBe(true);
    pendingApproval = true; expect(await source.isDesktopRecoveryIdle(id)).toBe(false);
    pendingApproval = false; hookActive = true; expect(await source.isDesktopRecoveryIdle(id)).toBe(false);
    hookActive = false; health = "stale"; expect(await source.isDesktopRecoveryIdle(id)).toBe(false);
    health = "ready";
    await Bun.write(path, JSON.stringify({ type: "event_msg", timestamp: "2026-10-06T00:00:01Z", payload: { type: "task_started", turn_id: "turn" } }) + "\n");
    expect(await source.isDesktopRecoveryIdle(id)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic opening cannot bypass an unknown idle state", async () => {
  const calls: string[] = [];
  const source = fixture(async (value) => { calls.push(value); });
  await expect(source.openDesktop(id, true)).rejects.toThrow("desktop_recovery_not_idle");
  expect(calls).toEqual([]);
});

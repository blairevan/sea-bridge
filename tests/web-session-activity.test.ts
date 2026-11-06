import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexWebSource } from "../src/web/sources/codex.ts";
import type { CodexThread } from "../src/desktop/codex-thread-store.ts";
import type { CodexReadTurn } from "../src/desktop/codex-read-service.ts";
import { SessionActivityResolver } from "../src/web/session-activity.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Write real lifecycle records so tests exercise the production confined reader. */
function record(type: string, turn = "turn", seconds = 1): string {
  return JSON.stringify({ type: "event_msg", timestamp: new Date(seconds * 1000).toISOString(), payload: { type, turn_id: turn } }) + "\n";
}

/** Build a source around a real rollout and a controllable external read service. */
function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), "session-activity-")); roots.push(root);
  const path = join(root, "rollout.jsonl"); writeFileSync(path, text);
  const thread: CodexThread = { id: "thread", title: "fixture", updatedAtMs: 1000, rolloutPath: path };
  let observed: { state: "active" | "idle" | "unknown"; turnId: string | null } | null = null;
  let latest: CodexReadTurn | null = null;
  let calls = 0;
  const deps = {
    threads: { listActive: () => [thread], getThread: () => thread },
    catalogs: { async listProjects() { return []; }, async listModels() { return []; } },
    actions: { async startThreadAndTurn(): Promise<never> { throw new Error("unused"); } },
    queue: { async queue(): Promise<never> { throw new Error("unused"); } },
    sessionRoots: [root], pathExists: () => true, queueUsable: true, pendingApproval: () => false,
    activity: () => observed,
    readLatestTurn: async () => { calls++; return latest; },
  };
  return { source: new CodexWebSource(deps), deps, path, thread,
    observe(value: typeof observed) { observed = value; },
    latest(value: CodexReadTurn) { latest = value; },
    calls: () => calls,
  };
}

test("list discovers idle lifecycle without opening history and after source restart", async () => {
  const f = fixture(record("task_started") + record("task_complete", "turn", 2));
  expect((await f.source.sessions())[0]?.state).toBe("idle");
  expect((await new CodexWebSource(f.deps).sessions())[0]?.state).toBe("idle");
});

test("history and list agree on an unconfirmed interrupted turn instead of asserting running", async () => {
  const f = fixture(record("task_started"));
  f.observe({ state: "unknown", turnId: "turn" });
  f.latest({ id: "turn", status: "interrupted", startedAtMs: 1000, completedAtMs: null, itemsView: "summary" });
  const list = (await f.source.sessions())[0];
  expect(list).toMatchObject({ state: "unknown", stateConfirmation: { phase: "checking", reason: "conflicting_evidence" } });
  expect(await f.source.history("thread", null, 20)).toMatchObject({ sessionState: "unknown", stateConfirmation: { phase: "checking" } });
  expect(f.calls()).toBe(1);
});

test("a newer turn from the read service supersedes an older local terminal record", async () => {
  const f = fixture(record("task_complete", "old", 1));
  f.observe({ state: "active", turnId: "new" });
  f.latest({ id: "new", status: "inProgress", startedAtMs: 2000, completedAtMs: null, itemsView: "summary" });
  expect((await f.source.sessions())[0]?.state).toBe("running");
  expect((await f.source.history("thread", null, 20)).sessionState).toBe("running");
});

test("a terminal record added to the rollout invalidates cached running immediately", async () => {
  const f = fixture(record("task_started"));
  f.observe({ state: "active", turnId: "turn" });
  expect((await f.source.sessions())[0]?.state).toBe("running");
  appendFileSync(f.path, record("task_complete", "turn", 2));
  f.observe(null);
  expect((await f.source.sessions())[0]?.state).toBe("idle");
  expect((await f.source.history("thread", null, 20)).sessionState).toBe("idle");
});

test("a start record alone does not claim running when live confirmation is unavailable", async () => {
  const f = fixture(record("task_started"));
  expect((await f.source.sessions())[0]).toMatchObject({ state: "unknown", stateConfirmation: { phase: "checking" } });
});

test.each(["unknown", "idle"] as const)("fresh native execution overrides a stale %s observer for the same turn", async (state) => {
  const now = Date.now();
  const f = fixture(record("task_started", "turn", (now - 600_000) / 1000));
  appendFileSync(f.path, JSON.stringify({ type: "response_item", timestamp: new Date(now - 1000).toISOString(),
    payload: { type: "custom_tool_call", name: "exec_command", call_id: "fresh-call" } }) + "\n");
  f.observe({ state, turnId: "turn" });
  f.latest({ id: "turn", status: "interrupted", startedAtMs: now - 600_000, completedAtMs: null, itemsView: "summary" });
  expect((await f.source.sessions())[0]?.state).toBe("running");
  expect((await f.source.history("thread", null, 20)).sessionState).toBe("running");
});

test("progress from before a terminal or a newer turn cannot keep the old turn running", async () => {
  const now = Date.now();
  const progress = JSON.stringify({ type: "response_item", timestamp: new Date(now - 1000).toISOString(), payload: { type: "reasoning" } }) + "\n";
  const f = fixture(record("task_started", "old", (now - 2000) / 1000) + progress + record("task_complete", "old", now / 1000));
  expect((await f.source.sessions())[0]?.state).toBe("idle");
  appendFileSync(f.path, record("task_started", "new", (now + 1) / 1000));
  f.observe({ state: "unknown", turnId: "new" });
  expect((await f.source.sessions())[0]?.state).toBe("unknown");
});

test.each(["stale", "metadata", "user", "other-turn"])("%s records are not live execution evidence", async (kind) => {
  const now = Date.now();
  const f = fixture(record("task_started", "turn", (now - 600_000) / 1000));
  const row = kind === "metadata"
    ? { type: "event_msg", timestamp: new Date(now).toISOString(), payload: { type: "thread_settings_applied" } }
    : kind === "user"
      ? { type: "response_item", timestamp: new Date(now).toISOString(), payload: { type: "message", role: "user", content: [] } }
      : { type: "response_item", timestamp: new Date(kind === "stale" ? now - 300_000 : now).toISOString(),
        payload: { type: "reasoning", ...(kind === "other-turn" ? { turn_id: "other" } : {}) } };
  appendFileSync(f.path, JSON.stringify(row) + "\n");
  f.observe({ state: "unknown", turnId: "turn" });
  expect((await f.source.sessions())[0]?.state).toBe("unknown");
});

test("unchanged terminal evidence survives expiry without reopening history", async () => {
  const f = fixture(record("task_complete"));
  let now = 1000;
  const resolver = new SessionActivityResolver(f.deps.sessionRoots, f.deps.readLatestTurn, () => now);
  expect((await resolver.resolve(f.thread, null)).state).toBe("idle");
  now += 60_000;
  expect((await resolver.resolve(f.thread, null)).state).toBe("idle");
});

test("conflicts expire visibly, retry, and converge when the exact turn is confirmed", async () => {
  const f = fixture(record("task_started"));
  let now = 1000;
  const resolver = new SessionActivityResolver(f.deps.sessionRoots, f.deps.readLatestTurn, () => now);
  f.latest({ id: "turn", status: "interrupted", startedAtMs: 1000, completedAtMs: null, itemsView: "summary" });
  const observed = { state: "unknown" as const, turnId: "turn" };
  expect((await resolver.resolve(f.thread, observed)).stateConfirmation?.phase).toBe("checking");
  now += 31_000;
  expect((await resolver.resolve(f.thread, observed)).stateConfirmation?.phase).toBe("unavailable");
  f.latest({ id: "turn", status: "interrupted", startedAtMs: 1000, completedAtMs: 32_000, itemsView: "summary" });
  now += 11_000;
  expect(await resolver.resolve(f.thread, observed)).toMatchObject({ state: "idle" });
  expect(f.calls()).toBe(3);
});

test("a failed refresh retains last confirmed state as context without granting live controls", async () => {
  const f = fixture(record("task_complete"));
  const resolver = new SessionActivityResolver(f.deps.sessionRoots, f.deps.readLatestTurn);
  expect((await resolver.resolve(f.thread, null)).state).toBe("idle");
  rmSync(f.path);
  expect(await resolver.resolve(f.thread, null)).toMatchObject({ state: "unknown", activity: null,
    stateConfirmation: { phase: "checking", reason: "read_unavailable", lastKnownState: "idle" } });
});

test("visible page and exact session selection probe older threads without reading the whole catalog", async () => {
  const f = fixture(record("task_complete"));
  const missing = { ...f.thread, id: "newer", title: "newer", updatedAtMs: 2000, rolloutPath: null };
  f.deps.threads.listActive = () => [missing, f.thread];
  const source = new CodexWebSource(f.deps);
  expect((await source.sessions({ offset: 1, limit: 1 })).find((item) => item.id === "thread")?.state).toBe("idle");
  expect((await source.sessions({ sessionId: "thread", limit: 1 })).find((item) => item.id === "thread")?.state).toBe("idle");
});

test("an older RPC turn cannot overwrite a newer local lifecycle", async () => {
  const f = fixture(record("task_started", "new", 20));
  f.observe({ state: "unknown", turnId: "new" });
  f.latest({ id: "old", status: "completed", startedAtMs: 1000, completedAtMs: 2000, itemsView: "summary" });
  expect((await f.source.sessions())[0]?.state).toBe("unknown");
  appendFileSync(f.path, record("task_complete", "new", 21));
  expect((await f.source.sessions())[0]?.state).toBe("idle");
});

test("catalog recency newer than a local terminal requires checking for a new turn without an observer", async () => {
  const f = fixture(record("task_complete", "old", 1));
  f.thread.updatedAtMs = 2000;
  f.latest({ id: "new", status: "inProgress", startedAtMs: 2000, completedAtMs: null, itemsView: "summary" });
  expect((await f.source.sessions())[0]?.state).toBe("running");
  expect(f.calls()).toBe(1);
});

test("slow remote probes do not block the list indefinitely or duplicate pending queries", async () => {
  const f = fixture(record("task_started"));
  let calls = 0;
  let finish: ((value: CodexReadTurn | null) => void) | undefined;
  const remote = new Promise<CodexReadTurn | null>((resolve) => { finish = resolve; });
  const resolver = new SessionActivityResolver(f.deps.sessionRoots, () => { calls++; return remote; });
  const before = Date.now();
  const first = await resolver.resolve(f.thread, null);
  expect(first.state).toBe("unknown");
  expect(Date.now() - before).toBeLessThan(2000);
  const second = resolver.resolve(f.thread, null);
  finish?.({ id: "turn", status: "inProgress", startedAtMs: 1000, completedAtMs: null, itemsView: "summary" });
  expect((await second).state).toBe("running");
  expect(calls).toBe(1);
});

test("a pending old snapshot does not block a new turn probe or overwrite its cache later", async () => {
  const f = fixture(record("task_started", "old", 1));
  let calls = 0;
  let finish: ((value: CodexReadTurn | null) => void) | undefined;
  const old = new Promise<CodexReadTurn | null>((resolve) => { finish = resolve; });
  const resolver = new SessionActivityResolver(f.deps.sessionRoots, async () => {
    calls++;
    return calls === 1 ? old : { id: "new", status: "inProgress", startedAtMs: 2000, completedAtMs: null, itemsView: "summary" };
  });
  expect((await resolver.resolve(f.thread, null)).state).toBe("unknown");
  appendFileSync(f.path, record("task_started", "new", 2));
  const observed = { state: "unknown" as const, turnId: "new" };
  expect((await resolver.resolve(f.thread, observed)).state).toBe("running");
  finish?.({ id: "old", status: "completed", startedAtMs: 1000, completedAtMs: 1500, itemsView: "summary" });
  await old;
  expect((await resolver.resolve(f.thread, observed)).activity?.turnId).toBe("new");
  expect(calls).toBe(2);
});

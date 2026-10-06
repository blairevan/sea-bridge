import { expect, test } from "bun:test";
import { CodexQueueRecovery, type CodexQueueRecoveryNotice } from "../src/desktop/codex-queue-recovery.ts";
import type { CodexQueueMetadataSnapshot } from "../src/desktop/codex-queue-store.ts";
import type { Logger } from "../src/logger.ts";

/** Inject native queue snapshots, evidence and time without activating a real Desktop. */
function fixture() {
  let now = 10_000;
  let idle = true;
  let snapshot: CodexQueueMetadataSnapshot = { available: true, truncated: false, items: [
    { id: "item", threadId: "thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 0 },
  ] };
  const opened: string[] = [];
  const events: string[] = [];
  const logger: Logger = { debug() {}, info(event) { events.push(event); }, warn(event) { events.push(event); }, error() {} };
  const deps = { logger, now: () => now, readQueue: () => snapshot,
    isIdle: async (_id: string) => idle,
    onRecovery: (_notice: CodexQueueRecoveryNotice) => {},
    openDesktop: async (id: string) => { opened.push(id); } };
  const recovery = new CodexQueueRecovery(deps);
  return { recovery, deps, opened, events, setTime(value: number) { now = value; },
    setIdle(value: boolean) { idle = value; }, setSnapshot(value: CodexQueueMetadataSnapshot) { snapshot = value; } };
}

test("idle queued tasks activate only after ten seconds, once per pending batch", async () => {
  const f = fixture();
  await f.recovery.pollOnce(); expect(f.opened).toEqual([]);
  f.setTime(10_001); await f.recovery.pollOnce(); expect(f.opened).toEqual(["thread"]);
  await f.recovery.pollOnce(); expect(f.opened).toHaveLength(1);
  f.setSnapshot({ available: true, truncated: false, items: [
    { id: "next", threadId: "thread", clientId: null, createdAt: 10_001, updatedAt: 10_001, queueOrder: 0 },
  ] });
  f.setTime(20_002); await f.recovery.pollOnce(); expect(f.opened).toHaveLength(2);
});

test("non-idle or unavailable and partial queue evidence never activates Desktop", async () => {
  const f = fixture(); f.setTime(20_000); f.setIdle(false);
  await f.recovery.pollOnce(); expect(f.opened).toEqual([]);
  f.setIdle(true); f.setSnapshot({ available: false, truncated: false, items: [] });
  await f.recovery.pollOnce(); expect(f.opened).toEqual([]);
  f.setSnapshot({ available: true, truncated: true, items: [] });
  await f.recovery.pollOnce(); expect(f.opened).toEqual([]);
});

test("queue consumption during evidence read prevents activation", async () => {
  const f = fixture(); f.setTime(20_000);
  f.deps.isIdle = async () => { f.setSnapshot({ available: true, truncated: false, items: [] }); return true; };
  await f.recovery.pollOnce(); expect(f.opened).toEqual([]);
});

test("state changes before opening prevent activation", async () => {
  const f = fixture(); f.setTime(20_000); let reads = 0;
  f.deps.isIdle = async () => ++reads === 1;
  await f.recovery.pollOnce(); expect(f.opened).toEqual([]);
});

test("activation failure is recorded without repeated window switches", async () => {
  const f = fixture(); f.setTime(20_000);
  f.deps.openDesktop = async (id) => { f.opened.push(id); throw new Error("failed"); };
  await f.recovery.pollOnce(); await f.recovery.pollOnce();
  expect(f.opened).toHaveLength(1); expect(f.events).toContain("codex_queue_recovery_failed");
});

test("overlapping polls share one attempt and stopping prevents later activation", async () => {
  const f = fixture(); f.setTime(20_000);
  await Promise.all([f.recovery.pollOnce(), f.recovery.pollOnce()]); expect(f.opened).toHaveLength(1);
  await f.recovery.stop(); await f.recovery.pollOnce(); expect(f.opened).toHaveLength(1);
});

test("failed queue reads preserve deduplication and a drained queue permits later tasks", async () => {
  const f = fixture(); f.setTime(20_000); await f.recovery.pollOnce();
  f.setSnapshot({ available: false, truncated: false, items: [] }); await f.recovery.pollOnce();
  f.setTime(30_000); f.setSnapshot({ available: true, truncated: false, items: [
    { id: "item", threadId: "thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 0 },
  ] });
  await f.recovery.pollOnce(); expect(f.opened).toHaveLength(1);
  f.setSnapshot({ available: true, truncated: false, items: [] }); await f.recovery.pollOnce();
  f.setSnapshot({ available: true, truncated: false, items: [
    { id: "fresh", threadId: "thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 0 },
  ] });
  await f.recovery.pollOnce(); expect(f.opened).toHaveLength(2);
});

test("multiple threads respect global cooldown and one pending batch triggers only once", async () => {
  const f = fixture(); f.setTime(20_000);
  f.setSnapshot({ available: true, truncated: false, items: [
    { id: "first", threadId: "thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 0 },
    { id: "second", threadId: "thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 1 },
    { id: "other", threadId: "other-thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 0 },
  ] });
  await f.recovery.pollOnce(); expect(f.opened).toEqual(["thread"]);
  f.setTime(24_999); await f.recovery.pollOnce(); expect(f.opened).toHaveLength(1);
  f.setTime(25_000); await f.recovery.pollOnce(); expect(f.opened).toEqual(["thread", "other-thread"]);
});

test("shutdown waits for a pending evidence read and never opens afterward", async () => {
  const f = fixture(); f.setTime(20_000);
  let release: ((value: boolean) => void) | undefined;
  f.deps.isIdle = () => new Promise<boolean>((resolve) => { release = resolve; });
  const poll = f.recovery.pollOnce();
  const stopping = f.recovery.stop();
  release?.(true); await Promise.all([poll, stopping]);
  expect(f.opened).toEqual([]);
});

test("evidence errors do not prevent recovery of another eligible thread", async () => {
  const f = fixture(); f.setTime(20_000);
  f.setSnapshot({ available: true, truncated: false, items: [
    { id: "bad", threadId: "bad-thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 0 },
    { id: "good", threadId: "good-thread", clientId: null, createdAt: 0, updatedAt: 0, queueOrder: 0 },
  ] });
  f.deps.isIdle = async (id) => { if (id === "bad-thread") throw new Error("unknown"); return true; };
  await f.recovery.pollOnce(); expect(f.opened).toEqual(["good-thread"]);
});

test("recovery announces only the actual activation outcome, once", async () => {
  const f = fixture(); f.setTime(20_000);
  const notices: CodexQueueRecoveryNotice[] = [];
  f.deps.onRecovery = (event) => { notices.push(event); };
  await f.recovery.pollOnce(); await f.recovery.pollOnce();
  expect(notices).toEqual([{ threadId: "thread", outcome: "open_requested", occurredAt: 20_000 }]);
  const failure = fixture(); failure.setTime(20_000);
  failure.deps.onRecovery = (event) => { notices.push(event); };
  failure.deps.openDesktop = async () => { throw new Error("failed"); };
  await failure.recovery.pollOnce();
  expect(notices[1]?.outcome).toBe("failed");
});

test("notification failure cannot alter a successful Desktop activation outcome", async () => {
  const f = fixture(); f.setTime(20_000);
  f.deps.onRecovery = () => { throw new Error("stream unavailable"); };
  await f.recovery.pollOnce(); await f.recovery.pollOnce();
  expect(f.opened).toHaveLength(1);
  expect(f.events).not.toContain("codex_queue_recovery_failed");
});

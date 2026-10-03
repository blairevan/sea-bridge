import { expect, test } from "bun:test";
import type { Logger } from "../src/logger.ts";
import type { CodexQueueMetadata, CodexQueueMetadataSnapshot } from "../src/desktop/codex-queue-store.ts";
import { CodexQueueDiagnostics } from "../src/desktop/codex-queue-diagnostics.ts";

/** Create deterministic diagnostic inputs without modifying any native queue. */
function fixture() {
  let time = 1000;
  let snapshot: CodexQueueMetadataSnapshot = { available: true, truncated: false, items: [] };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  /** Capture structured fields only for privacy and event assertions. */
  const capture = (event: string, fields: Record<string, unknown> = {}) => { logs.push({ event, fields }); };
  const logger: Logger = { debug: capture, info: capture, warn: capture, error: capture };
  const diagnostics = new CodexQueueDiagnostics({ logger, readQueue: () => snapshot, now: () => time,
    evidence: async () => ({ available: true, activity: { state: "idle", turnId: "old-turn", observedAt: 500 },
      matches: new Map(), pendingApproval: false, hook: null }),
    processes: async () => ({ available: true, desktopPids: [7], codexChildPids: [8] }),
  });
  /** Advance the fake observation clock. */
  function advance(ms: number) { time += ms; }
  /** Replace the native metadata snapshot, including unavailable/truncated cases. */
  function setSnapshot(value: CodexQueueMetadataSnapshot) { snapshot = value; }
  return { diagnostics, logs, advance, setSnapshot };
}

const item: CodexQueueMetadata = { id: "queue-a", threadId: "thread-a", clientId: "client-a", createdAt: 1000, updatedAt: 1000, queueOrder: 0 };

test("logs long waiting with bounded repetition and never calls removal execution", async () => {
  const f = fixture(); f.setSnapshot({ available: true, truncated: false, items: [item] });
  await f.diagnostics.pollOnce(); f.advance(120000); await f.diagnostics.pollOnce(); await f.diagnostics.pollOnce();
  expect(f.logs.filter((entry) => entry.event === "codex_queue_waiting_long")).toHaveLength(1);
  expect(f.logs.find((entry) => entry.event === "codex_queue_waiting_long")?.fields).toMatchObject({ queueItemId: "queue-a", queuePosition: 1, queueDepth: 1, desktopPids: [7], latestTurnId: "old-turn", latestState: "idle" });
  f.setSnapshot({ available: true, truncated: false, items: [] }); await f.diagnostics.pollOnce();
  expect(f.logs.filter((entry) => entry.event === "codex_queue_item_left")).toHaveLength(1);
  expect(f.logs.some((entry) => entry.event === "codex_queue_execution_observed")).toBe(false);
  f.advance(120000); await f.diagnostics.pollOnce();
  expect(f.logs.some((entry) => entry.event === "codex_queue_execution_unconfirmed")).toBe(true);
});

test("unavailable or truncated snapshots cannot prove that an item left the queue", async () => {
  const f = fixture(); f.setSnapshot({ available: true, truncated: false, items: [item] }); await f.diagnostics.pollOnce();
  f.setSnapshot({ available: false, truncated: false, items: [], errorCode: "SQLITE_BUSY" });
  await f.diagnostics.pollOnce(); await f.diagnostics.pollOnce();
  expect(f.logs.filter((entry) => entry.event === "codex_queue_read_unavailable")).toHaveLength(1);
  f.setSnapshot({ available: true, truncated: true, items: [] }); await f.diagnostics.pollOnce();
  expect(f.logs.some((entry) => entry.event === "codex_queue_item_left")).toBe(false);
  expect(f.logs.some((entry) => entry.event === "codex_queue_read_recovered")).toBe(true);
});

test("stop drains the in-flight evidence read and start is idempotent", async () => {
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
  const diagnostics = new CodexQueueDiagnostics({ logger: quiet, now: () => 200000,
    readQueue: () => ({ available: true, truncated: false, items: [item] }),
    evidence: async () => { entered(); await held; return { available: false, activity: null, matches: new Map(), pendingApproval: false, hook: null }; },
    processes: async () => ({ available: false, desktopPids: [], codexChildPids: [] }),
  });
  diagnostics.start(); diagnostics.start(); await reading;
  let stopped = false; const stopping = diagnostics.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); release(); await stopping; expect(stopped).toBe(true);
});


test("correlates removed input to its native turn and reports observation gaps", async () => {
  let pending = true; let time = 1000;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  /** Capture diagnostics without any prompt content. */
  const capture = (event: string, fields: Record<string, unknown> = {}) => { logs.push({ event, fields }); };
  const diagnostics = new CodexQueueDiagnostics({ logger: { debug: capture, info: capture, warn: capture, error: capture },
    now: () => time, readQueue: () => ({ available: true, truncated: false, items: pending ? [item] : [] }),
    evidence: async () => ({ available: true, activity: null, pendingApproval: false, hook: null,
      matches: new Map([["client-a", { turnId: "turn-a", observedAt: 2000, state: "started" as const, startedAt: 2000, completedAt: null }]]) }),
    processes: async () => ({ available: true, desktopPids: [], codexChildPids: [] }),
  });
  await diagnostics.pollOnce(); pending = false; time = 50000; await diagnostics.pollOnce();
  expect(logs.find((entry) => entry.event === "codex_queue_execution_observed")?.fields).toMatchObject({ queueItemId: "queue-a", clientMessageId: "client-a", turnId: "turn-a", exactClientMatch: true });
  expect(logs.some((entry) => entry.event === "codex_queue_observation_gap")).toBe(true);
  time += 200000; await diagnostics.pollOnce();
  expect(logs.some((entry) => entry.event === "codex_queue_execution_unconfirmed")).toBe(false);
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueueExecutionEvidence } from "../src/desktop/codex-queue-evidence.ts";

test("matches native client input to its own turn rather than the newest unrelated task", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-evidence-")); const path = join(root, "rollout.jsonl");
  const rows = [
    { timestamp: "2026-10-03T01:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
    { timestamp: "2026-10-03T01:00:01Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: { type: "UserMessage", client_id: "client-a", content: [{ text: "private body" }] } } },
    { timestamp: "2026-10-03T01:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } },
    { timestamp: "2026-10-03T01:00:03Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } },
  ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    const result = await readQueueExecutionEvidence(path, [root], ["client-a", "missing"]);
    expect(result.available).toBe(true);
    expect(result.matches.get("client-a")).toMatchObject({ turnId: "turn-a", state: "completed", startedAt: Date.parse(rows[0]!.timestamp), completedAt: Date.parse(rows[2]!.timestamp) });
    expect(result.matches.has("missing")).toBe(false);
    expect(result.activity).toMatchObject({ state: "active", turnId: "turn-b" });
    expect(JSON.stringify([...result.matches])).not.toContain("private body");
    expect(await readQueueExecutionEvidence(path, [join(root, "outside")], ["client-a"])).toMatchObject({ available: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

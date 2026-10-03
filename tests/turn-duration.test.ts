import { test, expect } from "bun:test";
import { parseTurnTiming, replyDurations, type TurnTimingRecord } from "../src/web/turn-duration.ts";

test("timing associates completed replies by native turn instead of adjacent user timestamps", () => {
  const rows: TurnTimingRecord[] = [
    { offset: 4, kind: "end", turnId: "a", time: 135000 },
    { offset: 2, kind: "reply", turnId: null, time: 134000 },
    { offset: 1, kind: "start", turnId: "a", time: 10000 },
    { offset: 5, kind: "start", turnId: "b", time: 140000 },
    { offset: 6, kind: "reply", turnId: null, time: 141000 },
  ];
  expect([...replyDurations(rows)]).toEqual([[2, 125000]]);
});

test("timing omits incomplete, reversed and unassociated turns", () => {
  expect([...replyDurations([
    { offset: 1, kind: "context", turnId: "a", time: 0 },
    { offset: 2, kind: "reply", turnId: null, time: 100 },
    { offset: 3, kind: "end", turnId: "a", time: 200 },
  ])]).toEqual([]);
  expect(parseTurnTiming("broken", 0)).toBeNull();
  expect(parseTurnTiming(JSON.stringify({ type: "event_msg", timestamp: "2026-10-03T10:00:00Z", payload: { type: "task_started", turn_id: "a" } }), 2)).toMatchObject({ kind: "start", turnId: "a", time: Date.parse("2026-10-03T10:00:00Z") });
});

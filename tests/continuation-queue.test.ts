import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { ContinuationQueue } from "../src/state/continuation-queue.ts";

describe("ContinuationQueue", () => {
  test("claims each item exactly once and can release failed delivery", () => {
    const state = new StateDb(":memory:");
    const queue = new ContinuationQueue(state);
    const item = queue.enqueue("session-1", "do the next thing", 101);

    const first = queue.claimNext("session-1", "turn-1");
    expect(first?.id).toBe(item.id);
    expect(queue.claimNext("session-1", "turn-1")).toBeNull();

    expect(queue.releaseClaim(item.id)).toBe(true);
    const retry = queue.claimNext("session-1", "turn-1");
    expect(retry?.id).toBe(item.id);
    expect(queue.markConsumed(item.id)).toBe(true);
    expect(queue.pendingCount("session-1")).toBe(0);
    state.close();
  });

  test("telegram update id is idempotent", () => {
    const state = new StateDb(":memory:");
    const queue = new ContinuationQueue(state);
    queue.enqueue("session-1", "one", 7);
    expect(() => queue.enqueue("session-1", "duplicate", 7)).toThrow();
    state.close();
  });
});

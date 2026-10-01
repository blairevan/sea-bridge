import { describe, expect, test } from "bun:test";
import { recoverDshHistory } from "../src/dsh/history-recovery.ts";
import type { DshHistoryPage } from "../src/dsh/types.ts";

/** Produce a synthetic page in ascending source order. */
function page(seqs: number[], hasMore = false): DshHistoryPage {
  return { events: seqs.map((seq) => ({ type: "turn/end", seq, time: seq })), hasMore, truncated: false };
}

describe("bounded dsh history recovery", () => {
  test("recovers exactly the interval through several backward pages", async () => {
    const beforeValues: Array<number | undefined> = [];
    const result = await recoverDshHistory(1, 6, async (beforeSeq) => {
      beforeValues.push(beforeSeq);
      return beforeSeq === undefined ? page([4, 5, 6], true) : page([1, 2, 3]);
    });
    expect(beforeValues).toEqual([undefined, 4]);
    expect(result.events.map((event) => event.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(result.pages).toBe(2);
  });

  test("fails closed on missing, truncated, exhausted and regressed intervals", async () => {
    await expect(recoverDshHistory(1, 6, async () => page([4, 6]))).rejects.toThrow("recovery_gap");
    await expect(recoverDshHistory(1, 6, async () => ({ ...page([4, 5, 6]), truncated: true })))
      .rejects.toThrow("recovery_page_unavailable");
    await expect(recoverDshHistory(1, 6, async () => page([4, 5, 6])))
      .rejects.toThrow("recovery_exhausted");
    await expect(recoverDshHistory(6, 5, async () => page([]))).rejects.toThrow("invalid_recovery_interval");
  });

  test("does not read or advance beyond a configured work bound", async () => {
    await expect(recoverDshHistory(0, 4, async () => page([4], true), { maxEvents: 3 }))
      .rejects.toThrow("invalid_recovery_interval");
    await expect(recoverDshHistory(0, 3, async () => page([3], true), { maxPages: 1 }))
      .rejects.toThrow("recovery_page_limit");
  });
});

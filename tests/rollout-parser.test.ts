import { describe, expect, test } from "bun:test";
import { parseRolloutChunk } from "../src/desktop/rollout-parser.ts";

describe("parseRolloutChunk", () => {
  test("emits one completed event with the final assistant text", () => {
    const events = parseRolloutChunk("thread-a", [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }),
      JSON.stringify({ type: "response_item", payload: {
        type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "final answer" }],
      } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } }),
    ].join("\n"));

    expect(events).toEqual([
      expect.objectContaining({ kind: "started", turnId: "turn-a", finalText: null }),
      expect.objectContaining({ kind: "completed", turnId: "turn-a", finalText: "final answer" }),
    ]);
  });

  test("does not report a completed event for an intermediate assistant message", () => {
    const events = parseRolloutChunk("thread-a", JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "working" }],
      },
    }));

    expect(events).toEqual([]);
  });
});

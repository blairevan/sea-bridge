import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCodexTranscript } from "../src/web/codex-transcript.ts";

test("bounded Codex reader accepts verified text and rejects path escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-rollout-"));
  try {
    const sessions = join(root, "sessions"); mkdirSync(sessions);
    const file = join(sessions, "fixture.jsonl");
    const records = [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "hidden" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done" }] } },
      { type: "response_item", payload: { type: "function_call", arguments: "hidden" } },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\nmalformed\n");
    const page = await readCodexTranscript(file, [sessions], null, 20);
    expect(page.messages.map((message) => [message.role, message.text])).toEqual([["user", "hello"], ["assistant", "done"]]);
    const outside = join(root, "outside"); writeFileSync(outside, "private fixture");
    symlinkSync(outside, join(sessions, "escape"));
    await expect(readCodexTranscript(outside, [sessions], null, 20)).rejects.toThrow("history_unavailable");
    await expect(readCodexTranscript(join(sessions, "escape"), [sessions], null, 20)).rejects.toThrow("history_unavailable");
    await expect(readCodexTranscript(sessions, [sessions], null, 20)).rejects.toThrow("history_unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("byte cursor pagination returns each message once and rejects invalid cursors", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-rollout-pages-"));
  try {
    const file = join(root, "fixture.jsonl");
    writeFileSync(file, Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: String(i) }] } })).join("\n") + "\n");
    let cursor: string | null = null; const texts: string[] = [];
    do { const page = await readCodexTranscript(file, [root], cursor, 2); texts.unshift(...page.messages.map((message) => message.text)); cursor = page.cursor; } while (cursor);
    expect(texts).toEqual(["0", "1", "2", "3", "4"]);
    await expect(readCodexTranscript(file, [root], "../escape", 2)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

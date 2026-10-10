import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCodexMessage, readCodexTranscript } from "../src/web/codex-transcript.ts";

const skill = "<skill>\n<name>fixture</name>\n<path>/fixture/SKILL.md</path>\n---\nname: fixture\n---\nInstructions.\n</skill>";
const aborted = "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>";

/** Encode a persisted message without normalizing its original text. */
function record(text: string, role = "user"): string {
  return JSON.stringify({ type: "response_item", payload: { type: "message", role, phase: "final_answer", content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
}

test("skill and aborted runtime records are hidden in paged history and exact reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-runtime-envelopes-"));
  const file = join(root, "fixture.jsonl");
  const lines = [record("$fixture"), record(skill), record(aborted), record(`${skill}\n${aborted}\n继续处理`), record("last")];
  const raw = lines.join("\n") + "\n";
  try {
    writeFileSync(file, raw);
    const texts: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await readCodexTranscript(file, [root], cursor, 2);
      texts.unshift(...page.messages.map((message) => message.text));
      cursor = page.cursor;
    } while (cursor);
    expect(texts).toEqual(["$fixture", "继续处理", "last"]);
    let offset = 0;
    for (const [index, line] of lines.entries()) {
      const message = await readCodexMessage(file, [root], `rollout-${offset}`);
      expect(message?.text ?? null).toBe(["$fixture", null, null, "继续处理", "last"][index] ?? null);
      offset += Buffer.byteLength(line + "\n");
    }
    expect(await Bun.file(file).text()).toBe(raw);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("quoted, malformed and unrelated skill-like text remains visible", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-runtime-preserved-"));
  const file = join(root, "fixture.jsonl");
  const preserved = [
    `请解释：\n${skill}`,
    `\`\`\`xml\n${skill}\n\`\`\``,
    "<skill>unfinished",
    "<skill>user-authored example</skill>",
    "<skill><name>fixture</name></skill>",
    "<skill><name></name><path></path></skill>",
    "<unknown_runtime>preserve</unknown_runtime>",
    "<turn_aborted>unfinished",
  ];
  try {
    writeFileSync(file, [...preserved.map((text) => record(text)), record(skill, "assistant")].join("\n") + "\n");
    expect((await readCodexTranscript(file, [root], null, 30)).messages.map((message) => message.text)).toEqual([...preserved, skill]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

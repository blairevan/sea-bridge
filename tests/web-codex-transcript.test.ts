import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCodexMessage, readCodexTranscript } from "../src/web/codex-transcript.ts";

test("environment-only records are hidden while mixed questions, examples and byte cursors survive", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-environment-context-"));
  const file = join(root, "fixture.jsonl");
  const environment = "<environment_context>\n<current_date>2026-10-04</current_date>\n<timezone>Asia/Shanghai</timezone>\n<filesystem><workspace_roots><root>/fixture</root></workspace_roots></filesystem>\n</environment_context>";
  const example = "```xml\n" + environment + "\n```";
  const incomplete = "<environment_context>\nunfinished";
  /** Construct a source record without changing its persisted original text. */
  const record = (text: string, role = "user") => ({ type: "response_item", payload: { type: "message", role, phase: "final_answer", content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  const raw = [record("first"), record(environment), record(environment + "\n\n真实提问"), record(example), record(incomplete), record(environment, "assistant")].map((item) => JSON.stringify(item)).join("\n") + "\n";
  try {
    writeFileSync(file, raw);
    const messages = []; let cursor: string | null = null;
    do {
      const page = await readCodexTranscript(file, [root], cursor, 2);
      messages.unshift(...page.messages); cursor = page.cursor;
    } while (cursor);
    expect(messages.map((message) => message.text)).toEqual(["first", "真实提问", example, incomplete, environment]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(5);
    expect(await Bun.file(file).text()).toBe(raw);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex runtime AGENTS envelopes are hidden while appended user requests and quoted examples survive", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-agents-envelope-"));
  const file = join(root, "fixture.jsonl");
  const agents = "# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>\nDo not expose this runtime instruction.\n</INSTRUCTIONS>";
  const environment = "<environment_context>\n<cwd>/fixture</cwd>\n<shell>zsh</shell>\n</environment_context>";
  const pairedWithoutHeading = "<INSTRUCTIONS>\nInjected runtime rule.\n</INSTRUCTIONS>\n\n" + environment;
  const quoted = "请解释下面这段 Codex 元数据，而不是执行它：\n\n```text\n" + agents + "\n" + environment + "\n```";
  const directFence = "```text\n" + agents + "\n" + environment + "\n```";
  const incomplete = "# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>\nunfinished";
  const discussedRawAgents = agents + "\n\n请帮我审查上面的 AGENTS.md 规则";
  const attachment = "# Files mentioned by the user:\n\n## image.png: /tmp/codex-remote-attachments/thread/image.png\n\n## My request:\n看看图片";
  const record = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const raw = [
    record(agents + "\n\n" + environment),
    record(agents + "\n\n" + environment + "\n\n真实问题"),
    record(agents + "\n\n# AGENTS.md instructions for /fixture/sub\n\n<INSTRUCTIONS>\nNested runtime rule.\n</INSTRUCTIONS>\n\n" + environment + "\n\n嵌套后问题"),
    record(pairedWithoutHeading + "\n\n无标题封装后的问题"),
    record(environment + "\n\n" + attachment),
    record(quoted),
    record(directFence),
    record(incomplete),
    record(discussedRawAgents),
    record("我正在讨论 AGENTS.md instructions 和 <INSTRUCTIONS> 标签"),
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  try {
    writeFileSync(file, raw);
    const messages = []; let cursor: string | null = null;
    do {
      const page = await readCodexTranscript(file, [root], cursor, 20);
      messages.unshift(...page.messages); cursor = page.cursor;
    } while (cursor);
    expect(messages.map((message) => message.text)).toEqual([
      "真实问题",
      "嵌套后问题",
      "无标题封装后的问题",
      attachment,
      quoted,
      directFence,
      incomplete,
      discussedRawAgents,
      "我正在讨论 AGENTS.md instructions 和 <INSTRUCTIONS> 标签",
    ]);
    expect(await Bun.file(file).text()).toBe(raw);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded Codex reader accepts verified text and rejects path escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-rollout-"));
  try {
    const sessions = join(root, "sessions"); mkdirSync(sessions);
    const file = join(sessions, "fixture.jsonl");
    const records = [
      { timestamp: "2026-10-02T10:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "hidden" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done" }] } },
      { type: "response_item", payload: { type: "function_call", arguments: "hidden" } },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\nmalformed\n");
    const page = await readCodexTranscript(file, [sessions], null, 20);
    expect(page.messages.map((message) => [message.role, message.text])).toEqual([["user", "hello"], ["assistant", "done"]]);
    expect(page.messages[0]?.createdAt).toBe(Date.parse("2026-10-02T10:00:00Z"));
    expect(page.messages[1]?.createdAt).toBeNull();
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

test("latest visible reply survives multi-megabyte trailing tool/image gaps", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-rollout-gap-"));
  try {
    const file = join(root, "fixture.jsonl");
    const final = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "visible final" }] } });
    const tool = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(5 * 1024 * 1024) } });
    writeFileSync(file, final + "\n" + tool + "\n");
    const page = await readCodexTranscript(file, [root], null, 30);
    expect(page.messages.map((message) => message.text)).toEqual(["visible final"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large sparse rollouts stay readable because each history request is window-bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-rollout-large-"));
  try {
    const file = join(root, "fixture.jsonl");
    writeFileSync(file, "");
    truncateSync(file, 65 * 1024 * 1024);
    const final = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "large rollout final" }] } });
    appendFileSync(file, "\n" + final + "\n");
    const page = await readCodexTranscript(file, [root], null, 30);
    expect(page.messages.map((message) => message.text)).toEqual(["large rollout final"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("complete final JSON record is visible before a trailing newline is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-rollout-no-newline-"));
  try {
    const file = join(root, "fixture.jsonl");
    writeFileSync(file, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "tail final" }] } }));
    const page = await readCodexTranscript(file, [root], null, 30);
    expect(page.messages.map((message) => message.text)).toEqual(["tail final"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollout lifecycle evidence follows the last complete event and remains confined", async () => {
  const { readCodexActivity } = await import("../src/web/codex-transcript.ts");
  const root = mkdtempSync(join(tmpdir(), "web-activity-"));
  const file = join(root, "fixture.jsonl");
  try {
    writeFileSync(file, JSON.stringify({ timestamp: "2026-10-02T14:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }) + "\n");
    expect((await readCodexActivity(file, [root]))?.state).toBe("active");
    appendFileSync(file, JSON.stringify({ timestamp: "2026-10-02T14:01:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } }));
    expect(await readCodexActivity(file, [root])).toEqual({ state: "idle", turnId: "turn", observedAt: Date.parse("2026-10-02T14:01:00Z") });
    await expect(readCodexActivity(file, [])).rejects.toThrow("history_unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("history replies include native start-to-completion duration", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-turn-duration-"));
  try {
    const file = join(root, "fixture.jsonl");
    writeFileSync(file, [
      { timestamp: "2026-10-03T10:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "a" } },
      { timestamp: "2026-10-03T10:00:10Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done" }] } },
      { timestamp: "2026-10-03T10:00:12Z", type: "event_msg", payload: { type: "task_complete", turn_id: "a" } },
    ].map((row) => JSON.stringify(row)).join("\n"));
    expect((await readCodexTranscript(file, [root], null, 30)).messages[0]?.durationMs).toBe(12000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("exact native message reads enforce confinement, record boundaries and size bounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-exact-message-"));
  try {
    const sessions = join(root, "sessions"); mkdirSync(sessions);
    const file = join(sessions, "fixture.jsonl");
    const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "exact" }] } });
    writeFileSync(file, "{}\n" + line);
    expect((await readCodexMessage(file, [sessions], "rollout-3"))?.text).toBe("exact");
    expect(await readCodexMessage(file, [sessions], "rollout-0")).toBeNull();
    const runtimeAttachment = "# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>\nInjected.\n</INSTRUCTIONS>\n\n<environment_context>\n<cwd>/fixture</cwd>\n</environment_context>\n\n# Files mentioned by the user:\n\n## image.png: /tmp/codex-remote-attachments/thread/image.png\n\n## My request:\nInspect.";
    const runtimeLine = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: runtimeAttachment }] } });
    writeFileSync(file, runtimeLine);
    expect((await readCodexMessage(file, [sessions], "rollout-0"))?.text).toStartWith("# Files mentioned by the user:");
    await expect(readCodexMessage(file, [sessions], "rollout-4")).rejects.toThrow();
    await expect(readCodexMessage(file, [sessions], "rollout-03")).rejects.toThrow();
    await expect(readCodexMessage(file, [sessions], "rollout-99999")).rejects.toThrow();
    const outside = join(root, "outside.jsonl"); writeFileSync(outside, line);
    symlinkSync(outside, join(sessions, "escape"));
    await expect(readCodexMessage(outside, [sessions], "rollout-0")).rejects.toThrow();
    await expect(readCodexMessage(join(sessions, "escape"), [sessions], "rollout-0")).rejects.toThrow();
    writeFileSync(file, line.slice(0, -3));
    expect(await readCodexMessage(file, [sessions], "rollout-0")).toBeNull();
    writeFileSync(file, "x".repeat(4 * 1024 * 1024 + 1));
    await expect(readCodexMessage(file, [sessions], "rollout-0")).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large user messages with multi-hundred-kilobyte inline images are preserved and readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-large-image-transcript-"));
  try {
    const file = join(root, "fixture.jsonl");
    const largeBase64 = "a".repeat(800 * 1024);
    const dataUrl = `data:image/png;base64,${largeBase64}`;
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# Files mentioned by the user:\n\n## photo.png: /path/photo.png\n\n## My request:\nCheck this" },
          { type: "input_image", image_url: dataUrl }
        ]
      }
    });
    writeFileSync(file, line + "\n");
    const transcript = await readCodexTranscript(file, [root], null, 10);
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toContain("Check this");
    const exact = await readCodexMessage(file, [root], "rollout-0");
    expect(exact?.images).toHaveLength(1);
    expect(exact?.images?.[0]?.contentType).toBe("image/png");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex desktop apps runtime tags like external_codex_apps_open_page and client_time_context are hidden", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-desktop-tags-"));
  try {
    const file = join(root, "fixture.jsonl");
    const record = (text: string) => JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] }
    });
    const openPageTag = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
    const instructionsTag = '<codex_apps_open_page_instructions>Page instructions</codex_apps_open_page_instructions>';
    const timeTag = '<codex_apps_client_time_context>time</codex_apps_client_time_context>';
    const lines = [
      record("hello"),
      record(openPageTag),
      record(`${openPageTag}\n${instructionsTag}\n${timeTag}\n如何优化？`),
    ].join("\n") + "\n";
    writeFileSync(file, lines);
    const transcript = await readCodexTranscript(file, [root], null, 10);
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages.map((m) => m.text)).toEqual(["hello", "如何优化？"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

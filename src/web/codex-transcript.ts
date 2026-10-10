import { parseTurnTiming, replyDurations, type TurnTimingRecord } from "./turn-duration.ts";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import type { WebHistory, WebMessage } from "./sources/types.ts";

const READ_WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_RECORD_BYTES = 10 * 1024 * 1024;
const MAX_LATEST_SCAN_BYTES = 16 * 1024 * 1024;

/** Advance past whitespace without normalizing the preserved user text. */
function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index] ?? "")) index++;
  return index;
}

/** Consume one complete XML-like runtime block at the current logical start. */
function consumeRuntimeBlock(text: string, from: number, tag: string): number | null {
  const start = skipWhitespace(text, from);
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  if (!text.startsWith(openTag, start)) return null;
  const close = text.indexOf(closeTag, start + openTag.length);
  return close < 0 ? null : close + closeTag.length;
}

/** Require Codex's name/path header before treating a skill block as injected instructions. */
function consumeSkillEnvelope(text: string, from: number): number | null {
  const end = consumeRuntimeBlock(text, from, "skill");
  if (end === null) return null;
  const start = skipWhitespace(text, from);
  const body = text.slice(start + "<skill>".length, end - "</skill>".length);
  return /^\s*<name>\s*[^<\s][^<]*<\/name>\s*<path>\s*[^<\s][^<]*<\/path>/.test(body) ? end : null;
}

/** Consume Codex's generated AGENTS heading only when it is followed by a complete INSTRUCTIONS block. */
function consumeAgentsEnvelope(text: string, from: number): number | null {
  const start = skipWhitespace(text, from);
  const newline = text.indexOf("\n", start);
  const lineEnd = newline < 0 ? text.length : newline;
  const line = text.slice(start, lineEnd).replace(/\r$/, "");
  if (!/^# AGENTS\.md instructions(?: for .+)?$/.test(line)) return null;
  return consumeRuntimeBlock(text, newline < 0 ? lineEnd : newline + 1, "INSTRUCTIONS");
}

/** Require the stronger runtime shape before removing AGENTS text that a user could legitimately quote. */
function consumeAgentsRuntimeEnvelope(text: string, from: number): number | null {
  let cursor = from;
  let count = 0;
  while (true) {
    const next = consumeAgentsEnvelope(text, cursor);
    if (next === null) break;
    cursor = next;
    count++;
  }
  if (count === 0) return null;
  const environment = consumeRuntimeBlock(text, cursor, "environment_context");
  if (environment !== null) return environment;
  return skipWhitespace(text, cursor) === text.length ? cursor : null;
}

/**
 * Remove only complete leading Codex runtime envelopes.
 *
 * Quoted examples/fenced blocks are preserved because matching is anchored to the logical start.
 * A real question appended after the injected envelope remains visible.
 */
function userMessageText(text: string): string {
  let cursor = 0;
  let consumed = false;
  while (true) {
    const skill = consumeSkillEnvelope(text, cursor);
    if (skill !== null) {
      cursor = skill;
      consumed = true;
      continue;
    }

    const aborted = consumeRuntimeBlock(text, cursor, "turn_aborted");
    if (aborted !== null) {
      cursor = aborted;
      consumed = true;
      continue;
    }

    const agents = consumeAgentsRuntimeEnvelope(text, cursor);
    if (agents !== null) {
      cursor = agents;
      consumed = true;
      continue;
    }

    const environment = consumeRuntimeBlock(text, cursor, "environment_context");
    if (environment !== null) {
      cursor = environment;
      consumed = true;
      continue;
    }

    const openPage = consumeRuntimeBlock(text, cursor, "external_codex_apps_open_page");
    if (openPage !== null) {
      cursor = openPage;
      consumed = true;
      continue;
    }

    const openPageInst = consumeRuntimeBlock(text, cursor, "codex_apps_open_page_instructions");
    if (openPageInst !== null) {
      cursor = openPageInst;
      consumed = true;
      continue;
    }

    const timeContext = consumeRuntimeBlock(text, cursor, "codex_apps_client_time_context");
    if (timeContext !== null) {
      cursor = timeContext;
      consumed = true;
      continue;
    }

    // Some Codex builds omit the AGENTS heading but still emit the paired runtime envelope.
    const instructions = consumeRuntimeBlock(text, cursor, "INSTRUCTIONS");
    if (instructions !== null) {
      const pairedEnvironment = consumeRuntimeBlock(text, instructions, "environment_context");
      if (pairedEnvironment !== null) {
        cursor = pairedEnvironment;
        consumed = true;
        continue;
      }
    }
    break;
  }
  return consumed ? text.slice(skipWhitespace(text, cursor)) : text;
}

/** Parse only fixture-backed response-item user and final-answer records. */
function visibleMessage(line: string, offset: number, includeImages = false): WebMessage | null {
  let record: unknown;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record || typeof record !== "object") return null;
  const row = record as Record<string, unknown>;
  if (row.type !== "response_item" || !row.payload || typeof row.payload !== "object") return null;
  const payload = row.payload as Record<string, unknown>;
  if (payload.type !== "message" || !Array.isArray(payload.content)) return null;
  const role = payload.role;
  if (role !== "user" && !(role === "assistant" && payload.phase === "final_answer")) return null;
  const kind = role === "user" ? "input_text" : "output_text";
  const rawText = payload.content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    return item.type === kind && typeof item.text === "string" ? [item.text] : [];
  }).join("");
  const text = role === "user" ? userMessageText(rawText) : rawText;
  const parsedTime = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  if (!text) return null;
  const images = includeImages && role === "user" ? payload.content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    if (item.type === "input_image" && typeof item.image_url === "string") {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(item.image_url);
      if (match && match[1] && match[2]) return [{ contentType: match[1], base64: match[2] }];
    }
    return [];
  }) : [];
  return { id: `rollout-${offset}`, role, text, createdAt: Number.isFinite(parsedTime) ? parsedTime : null, ...(images.length > 0 ? { images } : {}) };
}

/** Open a regular rollout only after root confinement and inode identity checks. */
async function openConfinedRollout(path: string, roots: readonly string[]) {
  const actual = await realpath(path).catch(() => { throw new Error("history_unavailable"); });
  const allowedRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  if (!allowedRoots.some((root) => {
    if (!root) return false;
    const diff = relative(root, actual);
    return diff !== "" && diff !== ".." && !diff.startsWith("../") && !isAbsolute(diff);
  })) throw new Error("history_unavailable");
  const fileStat = await stat(actual);
  // Total rollout size may grow well past tens of MiB in tool/image-heavy sessions. Safety comes
  // from confined random-access windows and cursor bounds, so reject only non-regular/unsafe sizes.
  if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size) || fileStat.size < 0) throw new Error("history_unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new Error("history_unavailable"); });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== fileStat.ino || opened.dev !== fileStat.dev) throw new Error("history_unavailable");
    return { handle, opened };
  } catch (error) { await handle.close(); throw error; }
}

/** Read one complete native record by its byte identity, with the same confinement as history. */
export async function readCodexMessage(path: string, roots: readonly string[], messageId: string): Promise<WebMessage | null> {
  const match = /^rollout-(0|[1-9]\d*)$/.exec(messageId);
  if (!match) throw new Error("attachment_missing");
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) throw new Error("attachment_missing");
  const { handle, opened } = await openConfinedRollout(path, roots);
  try {
    if (offset >= opened.size) throw new Error("attachment_missing");
    if (offset > 0) {
      const previous = Buffer.alloc(1);
      const prior = await handle.read(previous, 0, 1, offset - 1);
      if (prior.bytesRead !== 1 || previous[0] !== 10) throw new Error("attachment_missing");
    }
    const buffer = Buffer.alloc(Math.min(READ_WINDOW_BYTES, opened.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.indexOf(10);
    if (newline < 0 && offset + bytesRead !== opened.size) throw new Error("attachment_missing");
    return visibleMessage(bytes.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8"), offset, true);
  } finally { await handle.close(); }
}

/** Read bounded 256 KiB windows from a confined file, skipping nonvisible records. */
export async function readCodexTranscript(path: string, roots: readonly string[], cursor: string | null, limit: number, observe?: (line: string, offset: number) => void): Promise<WebHistory> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("history_cursor_invalid");
  if (cursor !== null && !/^\d+$/.test(cursor)) throw new Error("history_cursor_invalid");
  const { handle, opened } = await openConfinedRollout(path, roots);
  try {
    const end = cursor === null ? opened.size : Number(cursor);
    if (!Number.isSafeInteger(end) || end < 0 || end > opened.size) throw new Error("history_cursor_invalid");
    const timings: TurnTimingRecord[] = [];
    /** Retain timing metadata alongside the existing observer without a second file scan. */
    const observeRecord = (line: string, offset: number): void => {
      observe?.(line, offset); const timing = parseTurnTiming(line, offset); if (timing) timings.push(timing);
    };
    const messages: Array<{ offset: number; message: WebMessage }> = [];
    let windowEnd = end; let alignedStart = end;
    const maxWindows = Math.ceil(MAX_LATEST_SCAN_BYTES / READ_WINDOW_BYTES);
    // Skip large tool/reasoning/image gaps while keeping the latest read bounded.
    for (let window = 0; window < maxWindows && windowEnd > 0 && messages.length < limit; window++) {
      const readEnd = windowEnd;
      const start = Math.max(0, readEnd - READ_WINDOW_BYTES);
      const buffer = Buffer.alloc(readEnd - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const bytes = buffer.subarray(0, bytesRead);
      let offset = 0;
      if (start > 0) {
        const previous = Buffer.alloc(1);
        const prior = await handle.read(previous, 0, 1, start - 1);
        if (prior.bytesRead !== 1) throw new Error("history_unavailable");
        if (previous[0] !== 10) {
          const newline = bytes.indexOf(10);
          if (newline < 0) { windowEnd = start; alignedStart = start; continue; }
          offset = newline + 1;
        }
      }
      alignedStart = start + offset;
      const page: Array<{ offset: number; message: WebMessage }> = [];
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        if (newline < 0) {
          // A fully-written JSON record need not end with a newline. Only the current EOF window
          // may safely attempt to parse such a tail; invalid/partially-written JSON stays hidden.
          if (readEnd === opened.size) {
            const line = bytes.subarray(offset).toString("utf8"); observeRecord(line, start + offset);
            const message = visibleMessage(line, start + offset);
            if (message) page.push({ offset: start + offset, message });
          }
          break;
        }
        const line = bytes.subarray(offset, newline).toString("utf8"); observeRecord(line, start + offset);
        const message = visibleMessage(line, start + offset);
        if (message) page.push({ offset: start + offset, message });
        offset = newline + 1;
      }
      messages.unshift(...page);
      windowEnd = alignedStart < readEnd ? alignedStart : start;
    }
    const durations = replyDurations(timings);
    for (const item of messages) { const duration = durations.get(item.offset); if (duration !== undefined) item.message.durationMs = duration; }
    const selected = messages.slice(-limit);
    const before = messages.length > limit ? selected[0]?.offset ?? alignedStart : alignedStart;
    return { messages: selected.map((item) => item.message), cursor: before > 0 ? String(before) : null, completeUserHistory: false };
  } finally { await handle.close(); }
}

/** Narrow lifecycle metadata; no prompt, tool or assistant text is returned. */
export interface CodexActivity { state: "active" | "idle"; turnId: string; observedAt: number; }

/** Reuse the confined bounded reader and select the newest complete lifecycle record by file offset. */
export async function readCodexActivity(path: string, roots: readonly string[]): Promise<CodexActivity | null> {
  let latest: CodexActivity | null = null; let latestOffset = -1;
  await readCodexTranscript(path, roots, null, 100, (line, offset) => {
    if (offset <= latestOffset) return;
    let record: unknown; try { record = JSON.parse(line); } catch { return; }
    if (!record || typeof record !== "object") return;
    const row = record as Record<string, unknown>;
    if (row.type !== "event_msg" || !row.payload || typeof row.payload !== "object" || typeof row.timestamp !== "string") return;
    const payload = row.payload as Record<string, unknown>; const observedAt = Date.parse(row.timestamp);
    if (!Number.isFinite(observedAt) || typeof payload.turn_id !== "string" || !payload.turn_id) return;
    if (!["task_started", "task_complete", "turn_aborted"].includes(String(payload.type))) return;
    latestOffset = offset;
    latest = { state: payload.type === "task_started" ? "active" : "idle", turnId: payload.turn_id, observedAt };
  });
  return latest;
}

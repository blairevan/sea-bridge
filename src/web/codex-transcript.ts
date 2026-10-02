import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import type { WebHistory, WebMessage } from "./sources/types.ts";

const READ_WINDOW_BYTES = 256 * 1024;
const MAX_LATEST_SCAN_BYTES = 16 * 1024 * 1024;

/** Parse only fixture-backed response-item user and final-answer records. */
function visibleMessage(line: string, offset: number): WebMessage | null {
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
  const text = payload.content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    return item.type === kind && typeof item.text === "string" ? [item.text] : [];
  }).join("");
  const parsedTime = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return text ? { id: `rollout-${offset}`, role, text, createdAt: Number.isFinite(parsedTime) ? parsedTime : null } : null;
}

/** Read bounded 256 KiB windows from a confined file, skipping nonvisible records. */
export async function readCodexTranscript(path: string, roots: readonly string[], cursor: string | null, limit: number): Promise<WebHistory> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("history_cursor_invalid");
  if (cursor !== null && !/^\d+$/.test(cursor)) throw new Error("history_cursor_invalid");
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
    const end = cursor === null ? opened.size : Number(cursor);
    if (!Number.isSafeInteger(end) || end < 0 || end > opened.size) throw new Error("history_cursor_invalid");
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
            const message = visibleMessage(bytes.subarray(offset).toString("utf8"), start + offset);
            if (message) page.push({ offset: start + offset, message });
          }
          break;
        }
        const message = visibleMessage(bytes.subarray(offset, newline).toString("utf8"), start + offset);
        if (message) page.push({ offset: start + offset, message });
        offset = newline + 1;
      }
      messages.unshift(...page);
      windowEnd = alignedStart < readEnd ? alignedStart : start;
    }
    const selected = messages.slice(-limit);
    const before = messages.length > limit ? selected[0]?.offset ?? alignedStart : alignedStart;
    return { messages: selected.map((item) => item.message), cursor: before > 0 ? String(before) : null, completeUserHistory: false };
  } finally { await handle.close(); }
}

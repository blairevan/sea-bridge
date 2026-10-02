import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import type { WebHistory, WebMessage } from "./sources/types.ts";

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
  return text ? { id: `rollout-${offset}`, role, text } : null;
}

/** Read at most 256 KiB from a regular confined file, paging backward by byte offset. */
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
  if (!fileStat.isFile() || fileStat.size > 64 * 1024 * 1024) throw new Error("history_unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new Error("history_unavailable"); });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== fileStat.ino || opened.dev !== fileStat.dev) throw new Error("history_unavailable");
    const end = cursor === null ? opened.size : Number(cursor);
    if (!Number.isSafeInteger(end) || end < 0 || end > opened.size) throw new Error("history_cursor_invalid");
    const start = Math.max(0, end - 256 * 1024);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    let offset = start > 0 ? bytes.indexOf(10) + 1 : 0;
    if (start > 0 && offset === 0) throw new Error("history_line_too_large");
    const alignedStart = start + offset;
    const messages: Array<{ offset: number; message: WebMessage }> = [];
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      if (newline < 0) break;
      const message = visibleMessage(bytes.subarray(offset, newline).toString("utf8"), start + offset);
      if (message) messages.push({ offset: start + offset, message });
      offset = newline + 1;
    }
    const selected = messages.slice(-limit);
    const before = messages.length > limit ? selected[0]?.offset ?? alignedStart : alignedStart;
    return { messages: selected.map((item) => item.message), cursor: before > 0 ? String(before) : null, completeUserHistory: false };
  } finally { await handle.close(); }
}

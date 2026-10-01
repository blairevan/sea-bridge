import { redact } from "../security/redact.ts";
import type { DshEventMetadata } from "./types.ts";

const TELEGRAM_LIMIT = 4_000;
const TITLE_LIMIT = 240;
const ANSWER_CHUNK_LIMIT = 3_400;

function safeTitle(title?: string): string {
  const value = typeof title === "string" && title.trim()
    ? String(redact(title.trim()))
    : "会话";
  return value.length <= TITLE_LIMIT ? value : value.slice(0, TITLE_LIMIT - 1) + "…";
}

function safeBoundary(text: string, proposedEnd: number): number {
  if (proposedEnd <= 0 || proposedEnd >= text.length) return proposedEnd;
  const before = text.charCodeAt(proposedEnd - 1);
  const after = text.charCodeAt(proposedEnd);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF
    ? proposedEnd - 1
    : proposedEnd;
}

function splitAnswer(text: string): string[] {
  if (text.length === 0) return [];
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = safeBoundary(text, Math.min(text.length, offset + ANSWER_CHUNK_LIMIT));
    if (end < text.length) {
      const window = text.slice(offset, end);
      const newline = window.lastIndexOf("\n");
      if (newline >= Math.floor(ANSWER_CHUNK_LIMIT * 0.6)) {
        end = offset + newline + 1;
      }
    }
    if (end <= offset) end = safeBoundary(text, Math.min(text.length, offset + ANSWER_CHUNK_LIMIT));
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

function statusText(reason: DshEventMetadata["reasonKind"]): string {
  return reason === "completed"
    ? "执行完成"
    : reason === "error"
      ? "执行失败"
      : reason === "aborted" || reason === "interrupted"
        ? "执行已中断"
        : reason === "max-tokens"
          ? "达到输出上限，可继续发送消息"
          : reason === "blocked"
            ? "执行被阻止"
            : reason === "forked"
              ? "轮次已在分支边界结束"
              : reason === "stop" || reason === "tool-calls"
                ? "轮次已结束"
                : "轮次已结束（原因未识别）";
}

export function formatDshTerminal(
  reason: DshEventMetadata["reasonKind"],
  title?: string,
  assistantText?: string | null,
): { eventKind: string; parts: string[] } {
  const displayTitle = safeTitle(title);
  const header = `dsh Web: ${displayTitle}\n状态: ${statusText(reason)}`;
  const answer = typeof assistantText === "string" ? String(redact(assistantText)) : "";
  const chunks = splitAnswer(answer);
  if (chunks.length === 0) return { eventKind: reason ?? "unknown", parts: [header] };

  const parts = chunks.map((chunk, index) => {
    const prefix = index === 0
      ? `${header}\n\n回答:\n`
      : `dsh Web: ${displayTitle}\n回答（${index + 1}/${chunks.length}）:\n`;
    const message = prefix + chunk;
    if (message.length > TELEGRAM_LIMIT) {
      throw new Error("dsh_notification_chunk_exceeds_telegram_limit");
    }
    return message;
  });
  return { eventKind: reason ?? "unknown", parts };
}

/** Backward-compatible completed formatter for status-only callers. */
export function formatDshCompletion(title?: string): string {
  return formatDshTerminal("completed", title).parts[0]!;
}

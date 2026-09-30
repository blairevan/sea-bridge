import { redact } from "../security/redact.ts";
import type { DshEventMetadata } from "./types.ts";

const TELEGRAM_LIMIT = 4_000;

function safeTitle(title?: string): string {
  return typeof title === "string" && title.trim()
    ? String(redact(title)).slice(0, 900)
    : "会话";
}

export function formatDshTerminal(
  reason: DshEventMetadata["reasonKind"],
  title?: string,
): { eventKind: string; text: string } {
  const status = reason === "completed"
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
  const eventKind = reason ?? "unknown";
  return {
    eventKind,
    text: `dsh Web: ${safeTitle(title)}\n状态: ${status}`.slice(0, TELEGRAM_LIMIT),
  };
}

/** Backward-compatible completed formatter. */
export function formatDshCompletion(title?: string): string {
  return formatDshTerminal("completed", title).text;
}

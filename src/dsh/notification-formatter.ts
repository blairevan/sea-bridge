import { redact } from "../security/redact.ts";

const TELEGRAM_LIMIT = 4_000;

/** Format only a verified completed outcome without exposing Host event data or raw IDs. */
export function formatDshCompletion(title?: string): string {
  const safeTitle = typeof title === "string" && title.trim()
    ? String(redact(title)).slice(0, 900)
    : "会话";
  return `dsh Web: ${safeTitle}\n状态: 执行完成`.slice(0, TELEGRAM_LIMIT);
}

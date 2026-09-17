import { createHash } from "node:crypto";
import type { DesktopMessageEventKind } from "../state/desktop-message-store.ts";

export interface DesktopTurnEvent {
  threadId: string;
  turnId: string | null;
  kind: DesktopMessageEventKind;
  finalText: string | null;
  fingerprint: string;
}

interface RolloutLine {
  type?: string;
  payload?: {
    type?: string;
    turn_id?: string;
    last_agent_message?: string | null;
    message?: string | null;
    role?: string;
    phase?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

function fingerprint(threadId: string, turnId: string | null, kind: DesktopMessageEventKind, finalText: string | null): string {
  return createHash("sha256").update(JSON.stringify({ threadId, turnId, kind, finalText })).digest("hex");
}

function event(threadId: string, turnId: string | null, kind: DesktopMessageEventKind, finalText: string | null): DesktopTurnEvent {
  return { threadId, turnId, kind, finalText, fingerprint: fingerprint(threadId, turnId, kind, finalText) };
}

function finalAssistantText(line: RolloutLine): string | null {
  const payload = line.payload;
  if (line.type !== "response_item" || payload?.type !== "message" || payload.role !== "assistant" || payload.phase !== "final_answer") {
    return null;
  }
  const parts = payload.content ?? [];
  const text = parts.filter((part) => part.type === "output_text" && typeof part.text === "string").map((part) => part.text ?? "").join("");
  return text || null;
}

export function parseRolloutChunk(threadId: string, jsonl: string): DesktopTurnEvent[] {
  const events: DesktopTurnEvent[] = [];
  let latestFinalText: string | null = null;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    const finalText = finalAssistantText(parsed);
    if (finalText) {
      latestFinalText = finalText;
      continue;
    }

    const payload = parsed.payload;
    if (parsed.type !== "event_msg" || !payload?.type) continue;
    const turnId = payload.turn_id ?? null;
    if (payload.type === "task_started") {
      events.push(event(threadId, turnId, "started", null));
    } else if (payload.type === "waiting_for_input") {
      events.push(event(threadId, turnId, "waiting_for_input", null));
    } else if (payload.type === "task_complete") {
      events.push(event(threadId, turnId, "completed", payload.last_agent_message ?? latestFinalText));
    } else if (payload.type === "error") {
      events.push(event(threadId, turnId, "failed", payload.message ?? latestFinalText));
    } else if (payload.type === "interrupted") {
      events.push(event(threadId, turnId, "interrupted", latestFinalText));
    }
  }
  return events;
}

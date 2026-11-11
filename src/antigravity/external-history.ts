import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LiveActivityItem } from "../web/codex-transcript.ts";
import type { WebHistory, WebMessage, WebSession } from "../web/sources/types.ts";
import { resolveInsideDirectory } from "./policy.ts";
import { extractAskQuestionPrompts } from "./question-parser.ts";

/** Summary row shape inside Antigravity `conversation_summaries.db`. */
export interface SummaryDbRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  not_fully_idle: number;
  source?: string;
}

interface TranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
  truncated_fields?: string[];
}

/** Open a SQLite database strictly in read-only mode, falling back to `immutable=1` when WAL sidecars are absent. */
export function queryReadOnlyDb<T>(dbPath: string, fn: (db: Database) => T): T | null {
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?immutable=1`]) {
    let db: Database | null = null;
    try {
      db = new Database(uri, { readonly: true });
      return fn(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (uri.endsWith("mode=ro") && /CANTOPEN|unable to open/i.test(msg)) {
        continue;
      }
      return null;
    } finally {
      try {
        db?.close(false);
      } catch {
        // ignore close error
      }
    }
  }
  return null;
}

/** Parse an ISO-8601 timestamp string into epoch milliseconds, returning `null` if invalid. */
export function parseTimestampMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Extract plain text from a transcript step's `content` payload. */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && "text" in content && typeof (content as { text?: unknown }).text === "string") {
    return ((content as { text: string }).text).trim();
  }
  return "";
}

/** Unwrap `<USER_REQUEST>...</USER_REQUEST>` tags emitted by Antigravity trajectories. */
function stripUserRequestTags(text: string): string {
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) return match[1].trim();
  return text.trim();
}

/** Read and project a conversation's `transcript.jsonl` (hydrating truncated steps from `transcript_full.jsonl`). */
export function readBrainTranscriptHistory(
  appDataDirPath: string,
  conversationId: string,
  sessionState: WebSession["state"] | undefined,
  sessionExists: boolean,
  limit = 100,
): WebHistory | null {
  const brainRoot = path.join(appDataDirPath, "brain");
  if (!existsSync(brainRoot)) {
    return sessionExists
      ? { messages: [], cursor: null, completeUserHistory: true, ...(sessionState ? { sessionState } : {}) }
      : null;
  }

  const relativeCompact = path.join(conversationId, ".system_generated", "logs", "transcript.jsonl");
  const compactPath = resolveInsideDirectory(brainRoot, relativeCompact);
  if (!compactPath || !existsSync(compactPath)) {
    if (!sessionExists) return null;
    return {
      messages: [],
      cursor: null,
      completeUserHistory: true,
      ...(sessionState ? { sessionState } : {}),
    };
  }

  const relativeFull = path.join(conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  const fullPath = resolveInsideDirectory(brainRoot, relativeFull);

  let compactLines: string[] = [];
  let fullLines: string[] | null = null;
  try {
    compactLines = readFileSync(compactPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return null;
  }

  const getFullStep = (lineIndex: number, stepIndex?: number): TranscriptStep | null => {
    if (fullLines === null) {
      if (fullPath && existsSync(fullPath)) {
        try {
          fullLines = readFileSync(fullPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
        } catch {
          fullLines = [];
        }
      } else {
        fullLines = [];
      }
    }
    const direct = fullLines[lineIndex];
    if (direct) {
      try {
        const parsed = JSON.parse(direct) as TranscriptStep;
        if (stepIndex === undefined || parsed.step_index === stepIndex) return parsed;
      } catch {
        // fall through
      }
    }
    if (stepIndex !== undefined) {
      for (const candidate of fullLines) {
        try {
          const parsed = JSON.parse(candidate) as TranscriptStep;
          if (parsed.step_index === stepIndex) return parsed;
        } catch {
          continue;
        }
      }
    }
    return null;
  };

  const messages: WebMessage[] = [];
  const activeTurnItems: LiveActivityItem[] = [];

  for (let i = 0; i < compactLines.length; i++) {
    let step: TranscriptStep;
    try {
      step = JSON.parse(compactLines[i]!) as TranscriptStep;
    } catch {
      continue;
    }
    if (Array.isArray(step.truncated_fields) && step.truncated_fields.length > 0) {
      const hydrated = getFullStep(i, step.step_index);
      if (hydrated) step = hydrated;
    }

    const stepId = `step-${step.step_index ?? i}`;
    const createdAt = parseTimestampMs(step.created_at);

    if (step.type === "USER_INPUT") {
      const cleanText = stripUserRequestTags(extractTextContent(step.content));
      if (cleanText) {
        messages.push({ id: `${stepId}-user`, role: "user", text: cleanText, createdAt });
      }
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      const isLastStep = i === compactLines.length - 1;
      const canHavePendingQuestion =
        isLastStep && (sessionState === "waiting_user_input" || sessionState === "running" || sessionState === undefined);
      const pendingQuestions = canHavePendingQuestion ? extractAskQuestionPrompts(step.tool_calls) : [];
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          const toolName = typeof tc?.name === "string" ? tc.name : "tool";
          if (pendingQuestions.length > 0 && toolName === "ask_question") continue;
          activeTurnItems.push({ kind: "tool", text: toolName });
        }
      }
      const replyText = extractTextContent(step.content);
      if (replyText) {
        messages.push({ id: `${stepId}-assistant`, role: "assistant", text: replyText, createdAt });
      }
      if (pendingQuestions.length > 0) {
        messages.push({
          id: `${stepId}-question`,
          role: "assistant",
          text: "",
          createdAt,
          questions: pendingQuestions,
        });
      }
    }
  }

  const hasTrailingQuestion = messages.at(-1)?.questions !== undefined;
  const effectiveState =
    hasTrailingQuestion && (sessionState === "running" || sessionState === "waiting_user_input")
      ? "waiting_user_input"
      : sessionState;

  return {
    messages: messages.slice(-Math.max(1, Math.min(200, limit))),
    cursor: null,
    completeUserHistory: true,
    ...(effectiveState ? { sessionState: effectiveState } : {}),
    ...(activeTurnItems.length > 0 ? { activeTurnItems: activeTurnItems.slice(-20) } : {}),
  };
}

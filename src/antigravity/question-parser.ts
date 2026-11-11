import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WebQuestionPrompt } from "../web/sources/types.ts";
import { resolveInsideDirectory } from "./policy.ts";

interface RawToolCall {
  name?: unknown;
  args?: Record<string, unknown> | undefined;
}

interface RawTranscriptTailStep {
  step_index?: number;
  type?: string;
  tool_calls?: unknown;
  truncated_fields?: unknown;
}

/** Extract normalized `WebQuestionPrompt` items from a transcript step's `tool_calls` array. */
export function extractAskQuestionPrompts(toolCalls: unknown): WebQuestionPrompt[] {
  if (!Array.isArray(toolCalls)) return [];
  const results: WebQuestionPrompt[] = [];

  for (const rawCall of toolCalls) {
    if (!rawCall || typeof rawCall !== "object") continue;
    const call = rawCall as RawToolCall;
    if (call.name !== "ask_question" || !call.args || typeof call.args !== "object") continue;

    let rawQuestions: unknown = call.args.questions;
    if (typeof rawQuestions === "string") {
      try {
        rawQuestions = JSON.parse(rawQuestions);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(rawQuestions)) continue;

    for (const item of rawQuestions.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const title = typeof rec.question === "string" ? rec.question.trim() : "";
      if (!title) continue;
      const options = Array.isArray(rec.options)
        ? rec.options
            .filter((opt): opt is string => typeof opt === "string" && opt.trim().length > 0)
            .map((opt) => opt.trim())
        : [];
      const multiSelect = rec.is_multi_select === true || rec.multiSelect === true;
      results.push({
        title,
        ...(options.length > 0 ? { options } : {}),
        multiSelect,
      });
    }
  }

  return results;
}

/**
 * Inspect only the final step of an active conversation's `transcript.jsonl` (hydrating from
 * `transcript_full.jsonl` when truncated) to detect a currently unanswered `ask_question` call.
 */
export function inspectPendingAskQuestion(appDataDirPath: string, conversationId: string): WebQuestionPrompt[] {
  const brainRoot = path.join(appDataDirPath, "brain");
  if (!existsSync(brainRoot)) return [];

  const compactRel = path.join(conversationId, ".system_generated", "logs", "transcript.jsonl");
  const compactPath = resolveInsideDirectory(brainRoot, compactRel);
  if (!compactPath || !existsSync(compactPath)) return [];

  let compactLines: string[];
  try {
    compactLines = readFileSync(compactPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
  if (compactLines.length === 0) return [];

  const lastIndex = compactLines.length - 1;
  let lastStep: RawTranscriptTailStep;
  try {
    lastStep = JSON.parse(compactLines[lastIndex]!) as RawTranscriptTailStep;
  } catch {
    return [];
  }
  if (lastStep.type !== "PLANNER_RESPONSE") return [];

  if (Array.isArray(lastStep.truncated_fields) && lastStep.truncated_fields.length > 0) {
    const fullRel = path.join(conversationId, ".system_generated", "logs", "transcript_full.jsonl");
    const fullPath = resolveInsideDirectory(brainRoot, fullRel);
    if (fullPath && existsSync(fullPath)) {
      try {
        const fullLines = readFileSync(fullPath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0);
        const direct = fullLines[lastIndex];
        let hydrated: RawTranscriptTailStep | null = null;
        if (direct) {
          try {
            const parsed = JSON.parse(direct) as RawTranscriptTailStep;
            if (lastStep.step_index === undefined || parsed.step_index === lastStep.step_index) {
              hydrated = parsed;
            }
          } catch {
            hydrated = null;
          }
        }
        if (!hydrated && lastStep.step_index !== undefined) {
          for (let idx = fullLines.length - 1; idx >= 0; idx--) {
            try {
              const candidate = JSON.parse(fullLines[idx]!) as RawTranscriptTailStep;
              if (candidate.step_index === lastStep.step_index) {
                hydrated = candidate;
                break;
              }
            } catch {
              continue;
            }
          }
        }
        if (hydrated) lastStep = hydrated;
      } catch {
        // Fall back to compact step if full transcript read fails.
      }
    }
  }

  return extractAskQuestionPrompts(lastStep.tool_calls);
}

/** Format one or multiple answers using Antigravity's native `A1: ...\nA2: ...` multi-question convention. */
export function formatAntigravityQuestionAnswers(answers: readonly string[]): string {
  const cleaned = answers.map((a) => a.trim()).filter((a) => a.length > 0);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0]!;
  return cleaned.map((ans, idx) => `A${idx + 1}: ${ans}`).join("\n");
}

/**
 * Expand numeric shorthand replies (such as `1 2 1 3`, `1,2`, or `1+3 2` for multi-select) against
 * `questions`. Any input that does not strictly match valid 1-based option indices is returned verbatim.
 */
export function expandQuestionShorthandReply(rawText: string, questions: readonly WebQuestionPrompt[]): string {
  const trimmed = rawText.trim();
  if (!trimmed || questions.length === 0) return trimmed;

  const tokens = trimmed
    .split(/[\s,，;；]+/)
    .map((tok) => tok.trim())
    .filter((tok) => tok.length > 0);

  if (tokens.length !== questions.length) return trimmed;

  const resolvedAnswers: string[] = [];
  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx]!;
    const options = q.options ?? [];
    if (options.length === 0) return trimmed;

    const token = tokens[qIdx]!;
    if (!/^\d+(?:[+/]\d+)*$/.test(token)) return trimmed;

    const subIndices = token.split(/[+/]/).map((part) => Number(part));
    if (subIndices.length > 1 && !q.multiSelect) return trimmed;

    const picked: string[] = [];
    const seen = new Set<number>();
    for (const oneBased of subIndices) {
      if (!Number.isSafeInteger(oneBased) || oneBased < 1 || oneBased > options.length) {
        return trimmed;
      }
      if (seen.has(oneBased)) continue;
      seen.add(oneBased);
      picked.push(options[oneBased - 1]!);
    }
    if (picked.length === 0) return trimmed;
    resolvedAnswers.push(picked.join("；"));
  }

  return formatAntigravityQuestionAnswers(resolvedAnswers);
}

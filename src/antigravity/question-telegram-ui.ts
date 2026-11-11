import { createHash, randomUUID } from "node:crypto";
import { redact } from "../security/redact.ts";
import type { InlineButton } from "../telegram/client.ts";
import type { SourceResult, SourceSendOptions, WebMessage, WebQuestionPrompt, WebSession } from "../web/sources/types.ts";
import type { AntigravityDesktopAppController } from "./desktop-app-controller.ts";
import { createAntigravityCallback } from "./menu-ui.ts";
import { expandQuestionShorthandReply, formatAntigravityQuestionAnswers } from "./question-parser.ts";
import type { AntigravityTelegramTransport } from "./desktop-observer.ts";
import type { TelegramHandlerClient } from "./telegram-handler.ts";
import type { AntigravitySessionOrigin, AntigravityTelegramStore, PendingAntigravityNotification } from "./telegram-store.ts";

const QUESTION_STATE_TTL_MS = 24 * 60 * 60_000;
const BUTTON_LABEL_LIMIT = 48;

interface OutboxQuestionPayload { sessionId: string; sessionOrigin: AntigravitySessionOrigin; questions: WebQuestionPrompt[] }
interface QuestionMetaRecord { sessionId: string; questions: WebQuestionPrompt[] }
interface QuestionWizardRecord {
  sessionId: string; sessionOrigin: AntigravitySessionOrigin; questions: WebQuestionPrompt[]; page: number; selections: number[][];
}

function readValidState<T>(store: AntigravityTelegramStore, key: string, now = Date.now()): T | null {
  const row = store.getState<T>(key);
  return row && (row.expiresAt === null || row.expiresAt > now) ? row.value : null;
}

function truncateLabel(text: string, max = BUTTON_LABEL_LIMIT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Build the formatted Telegram notification body for an Antigravity `waiting_user_input` question prompt. */
function formatTelegramQuestionText(title: string, prose: string, questions: WebQuestionPrompt[], writable: boolean): string {
  const safeTitle = String(redact(title || "Antigravity Session")).slice(0, 180);
  const safeProse = prose.trim() ? String(redact(prose.trim())).slice(0, 900) : "";
  const lines: string[] = ["❓ Antigravity 等待输入（桌面端）", `会话: ${safeTitle}`, `状态: 共 ${questions.length} 个问题待确认`];
  if (safeProse) lines.push("", safeProse);
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    lines.push("", `Q${i + 1} [${q.multiSelect ? "多选" : "单选"}]: ${String(redact(q.title)).slice(0, 300)}`);
    for (let j = 0; j < (q.options ?? []).length; j++) lines.push(`  ${j + 1}. ${String(redact(q.options![j]!)).slice(0, 180)}`);
  }
  lines.push(
    "",
    writable
      ? questions.length > 1
        ? "💡 可在下方逐题点选后点击「✅ 提交回答」，或点击「💬 回复」发送序号简写（如 1 1）与自由文本。"
        : "💡 可直接点击下方选项一键提交，或点击「💬 回复」输入自定义内容。"
      : "（当前未开启桌面会话写入，请前往 Antigravity 桌面端确认）",
  );
  return lines.join("\n").slice(0, 3900);
}

/** Enqueue a deduplicated real-time `waiting_user_input` notification for a Desktop session. */
export function enqueueDesktopQuestionNotification(params: {
  tgStore: AntigravityTelegramStore; chatId: string; desk: WebSession; messages: WebMessage[]; writable: boolean; now?: number;
}): boolean {
  const { tgStore, chatId, desk, messages, writable } = params;
  const now = params.now ?? Date.now();
  const qMsg = messages.at(-1);
  if (!qMsg?.questions?.length) return false;
  const stepPrefix = qMsg.id.replace(/-question$/, "");
  const prevMsg = messages.at(-2);
  const prose = prevMsg?.role === "assistant" && prevMsg.id === `${stepPrefix}-assistant` ? prevMsg.text : "";
  const fp = createHash("sha256")
    .update(JSON.stringify({ origin: "desktop", kind: "waiting_user_input", sessionId: desk.id, questionMessageId: qMsg.id }))
    .digest("hex");
  const payload: OutboxQuestionPayload = { sessionId: desk.id, sessionOrigin: "desktop", questions: qMsg.questions };
  tgStore.setState(`qoutbox:${fp}`, payload, now + QUESTION_STATE_TTL_MS, now);
  return tgStore.enqueueNotification(
    { eventFingerprint: fp, chatId, sessionId: desk.id, sessionOrigin: "desktop", eventKind: "waiting_user_input", text: formatTelegramQuestionText(desk.title, prose, qMsg.questions, writable) },
    now,
  );
}

/** Build 1-click option buttons for a single single-choice question. */
function buildSingleQuestionButtons(
  tgStore: AntigravityTelegramStore,
  chatId: string,
  sessionId: string,
  question: WebQuestionPrompt,
  tokens: string[],
  now = Date.now(),
): InlineButton[][] {
  const makeCb = (action: string, payload: Record<string, unknown>): string => {
    const cb = createAntigravityCallback(tgStore, chatId, action, payload, now, QUESTION_STATE_TTL_MS);
    tokens.push(cb.slice("agy:".length));
    return cb;
  };
  const rows: InlineButton[][] = (question.options ?? []).map((opt, idx) => [
    { text: truncateLabel(`${idx + 1}. ${opt}`), callback_data: makeCb("q.pick", { sessionId, qIndex: 0, optIndex: idx, immediate: true }) },
  ]);
  rows.push([{ text: "💬 回复", callback_data: makeCb("reply", { sessionId }) }]);
  return rows;
}

/** Build the multi-question or multi-select inline keyboard for the current wizard state. */
function buildWizardButtons(
  tgStore: AntigravityTelegramStore,
  chatId: string,
  wiz: QuestionWizardRecord,
  tokens: string[],
  now = Date.now(),
): InlineButton[][] {
  const total = wiz.questions.length;
  const page = Math.min(Math.max(0, wiz.page), Math.max(0, total - 1));
  const current = wiz.questions[page];
  const rows: InlineButton[][] = [];
  const makeCb = (action: string, payload: Record<string, unknown>): string => {
    const cb = createAntigravityCallback(tgStore, chatId, action, payload, now, QUESTION_STATE_TTL_MS);
    tokens.push(cb.slice("agy:".length));
    return cb;
  };

  if (current) {
    const selectedSet = new Set(wiz.selections[page] ?? []);
    const opts = current.options ?? [];
    for (let idx = 0; idx < opts.length; idx++) {
      const active = selectedSet.has(idx);
      const prefix = current.multiSelect ? (active ? "☑️" : "⬜") : active ? "🔘" : "⚪";
      rows.push([
        {
          text: truncateLabel(`${prefix} ${idx + 1}. ${opts[idx]!}`),
          callback_data: makeCb(current.multiSelect ? "q.toggle" : "q.pick", { sessionId: wiz.sessionId, qIndex: page, optIndex: idx }),
        },
      ]);
    }
  }

  if (total > 1) {
    const navRow: InlineButton[] = [];
    if (page > 0) navRow.push({ text: `◀ 上一题 (${page}/${total})`, callback_data: makeCb("q.page", { sessionId: wiz.sessionId, page: page - 1 }) });
    if (page + 1 < total) navRow.push({ text: `下一题 (${page + 2}/${total}) ▶`, callback_data: makeCb("q.page", { sessionId: wiz.sessionId, page: page + 1 }) });
    if (navRow.length > 0) rows.push(navRow);
  }

  const answeredCount = wiz.selections.filter((sel) => sel.length > 0).length;
  rows.push([
    { text: total > 1 ? `✅ 提交回答 (${answeredCount}/${total})` : "✅ 提交回答", callback_data: makeCb("q.submit", { sessionId: wiz.sessionId }) },
    { text: "💬 回复", callback_data: makeCb("reply", { sessionId: wiz.sessionId }) },
  ]);
  return rows;
}

/** Build outbound inline buttons (and collect minted tokens for rollback on send failure) for an outbox notification. */
export function prepareNotificationKeyboard(params: {
  tgStore: AntigravityTelegramStore;
  notification: PendingAntigravityNotification;
  canReply: boolean;
  now?: number;
}): { buttons?: InlineButton[][]; callbackTokens: string[] } {
  const { tgStore, notification, canReply } = params;
  const now = params.now ?? Date.now();
  if (!canReply || notification.eventKind.endsWith("_part")) return { callbackTokens: [] };

  const tokens: string[] = [];
  if (notification.eventKind === "waiting_user_input") {
    const qPayload = readValidState<OutboxQuestionPayload>(tgStore, `qoutbox:${notification.eventFingerprint}`, now);
    if (qPayload && qPayload.questions.length > 0) {
      const first = qPayload.questions[0]!;
      if (qPayload.questions.length === 1 && !first.multiSelect && (first.options?.length ?? 0) > 0) {
        return { buttons: buildSingleQuestionButtons(tgStore, notification.chatId, notification.sessionId, first, tokens, now), callbackTokens: tokens };
      }
      const initialWiz: QuestionWizardRecord = {
        sessionId: notification.sessionId,
        sessionOrigin: notification.sessionOrigin,
        questions: qPayload.questions,
        page: 0,
        selections: qPayload.questions.map(() => []),
      };
      return { buttons: buildWizardButtons(tgStore, notification.chatId, initialWiz, tokens, now), callbackTokens: tokens };
    }
  }

  const cb = createAntigravityCallback(tgStore, notification.chatId, "reply", { sessionId: notification.sessionId }, now, QUESTION_STATE_TTL_MS);
  tokens.push(cb.slice("agy:".length));
  return { buttons: [[{ text: "💬 回复", callback_data: cb }]], callbackTokens: tokens };
}

/** Bind `qmeta` and `qwiz` records to the delivered Telegram `messageId` after `completeNotification` succeeds. */
export function finalizeQuestionNotification(
  tgStore: AntigravityTelegramStore,
  notification: PendingAntigravityNotification,
  messageId: number,
  now = Date.now(),
): void {
  if (notification.eventKind !== "waiting_user_input") return;
  const qPayload = readValidState<OutboxQuestionPayload>(tgStore, `qoutbox:${notification.eventFingerprint}`, now);
  if (!qPayload || qPayload.questions.length === 0) return;

  tgStore.setState(`qmeta:${notification.chatId}:${messageId}`, { sessionId: notification.sessionId, questions: qPayload.questions }, now + QUESTION_STATE_TTL_MS, now);
  if (qPayload.questions.length > 1 || qPayload.questions[0]?.multiSelect) {
    const wiz: QuestionWizardRecord = {
      sessionId: notification.sessionId,
      sessionOrigin: notification.sessionOrigin,
      questions: qPayload.questions,
      page: 0,
      selections: qPayload.questions.map(() => []),
    };
    tgStore.setState(`qwiz:${notification.chatId}:${messageId}`, wiz, now + QUESTION_STATE_TTL_MS, now);
  }
}

/** Copy question metadata from a question notification to its ForceReply prompt so shorthand replies expand cleanly. */
export function copyQuestionMetaToReplyPrompt(tgStore: AntigravityTelegramStore, chatId: string, sourceMessageId: number | undefined, promptMessageId: number, now = Date.now()): void {
  if (sourceMessageId === undefined) return;
  const meta = readValidState<QuestionMetaRecord>(tgStore, `qmeta:${chatId}:${sourceMessageId}`, now);
  if (meta) tgStore.setState(`qmeta:${chatId}:${promptMessageId}`, meta, now + QUESTION_STATE_TTL_MS, now);
}

/** Expand numeric shorthand (`1 1 1 1`, `2 1+3`) when replying to a question notification or its ForceReply prompt. */
export function expandReplyWithQuestionMeta(tgStore: AntigravityTelegramStore, chatId: string, replyMessageId: number, rawText: string, now = Date.now()): string {
  const trimmed = rawText.trim();
  if (!trimmed) return "";
  const meta = readValidState<QuestionMetaRecord>(tgStore, `qmeta:${chatId}:${replyMessageId}`, now);
  return meta && meta.questions.length > 0 ? expandQuestionShorthandReply(trimmed, meta.questions) : trimmed;
}

/** Send a `1A` confirmation message when another Desktop session is actively running during takeover. */
export async function sendDesktopTakeoverConfirmPrompt(params: {
  tgStore: AntigravityTelegramStore; telegram: Pick<AntigravityTelegramTransport, "sendMessage">; chatId: string | number; sessionId: string; promptText: string; now?: number;
}): Promise<void> {
  const { tgStore, telegram, chatId, sessionId, promptText } = params;
  const now = params.now ?? Date.now();
  const chatKey = String(chatId);
  const forceCb = createAntigravityCallback(tgStore, chatKey, "q.force_submit", { sessionId, promptText }, now, QUESTION_STATE_TTL_MS);
  const cancelCb = createAntigravityCallback(tgStore, chatKey, "q.cancel_force", { sessionId }, now, QUESTION_STATE_TTL_MS);
  await telegram.sendMessage(
    chatId,
    ["⚠️ 检测到 Antigravity 桌面端当前有其他会话正在运行任务。", "接管当前「等待输入」会话需要先退出桌面端以释放排他锁（完成后自动重开），可能中断另一运行中任务。是否强制继续？"].join("\n"),
    [[{ text: "⚠️ 强制重启桌面端并提交", callback_data: forceCb }], [{ text: "✖️ 取消", callback_data: cancelCb }]],
  );
}

/** Dispatch `q.*` Telegram inline keyboard callbacks for single-select, multi-question wizard, and forced takeover. */
export async function handleQuestionCallback(params: {
  action: string; payload: Record<string, unknown>; chatId: number; callbackId: string; sourceMessageId: number | undefined;
  tgStore: AntigravityTelegramStore; telegram: TelegramHandlerClient;
  sessionManager?: { send(id: string, operationId: string, prompt: string, options?: SourceSendOptions): Promise<SourceResult> } | undefined;
  desktopAppController?: AntigravityDesktopAppController | undefined;
}): Promise<void> {
  const { action, payload, chatId, callbackId, sourceMessageId, tgStore, telegram, sessionManager, desktopAppController } = params;
  const chatKey = String(chatId);
  const now = Date.now();

  if (action === "q.cancel_force") {
    await telegram.answerCallbackQuery(callbackId, "已取消强制接管").catch(() => undefined);
    if (sourceMessageId !== undefined) {
      await telegram.editMessageText(chatId, sourceMessageId, "已取消强制接管桌面端，本次回答未提交。", []).catch(() => undefined);
    }
    return;
  }

  if (!sessionManager) {
    await telegram.answerCallbackQuery(callbackId, "当前无法投递回答").catch(() => undefined);
    return;
  }

  const submitAnswer = async (sessionId: string, promptText: string, forceDesktopTakeover: boolean): Promise<boolean> => {
    const res = await sessionManager.send(sessionId, randomUUID(), promptText, {
      ...(forceDesktopTakeover ? { forceDesktopTakeover: true } : {}),
      notifyChatId: chatKey,
    });
    if (res.state === "queued" || res.state === "accepted") {
      desktopAppController?.markRefreshAfterTurn(sessionId, chatKey);
      if (sourceMessageId !== undefined) {
        const replyCb = createAntigravityCallback(tgStore, chatKey, "reply", { sessionId }, now, QUESTION_STATE_TTL_MS);
        await telegram.editMessageReplyMarkup(chatId, sourceMessageId, [[{ text: "💬 回复", callback_data: replyCb }]]).catch(() => undefined);
      }
      await telegram.sendMessage(chatId, `✅ 已投递回答到 Antigravity 会话：\n${promptText}`);
      return true;
    }
    if (res.errorCode === "desktop_takeover_confirm_required") {
      await sendDesktopTakeoverConfirmPrompt({ tgStore, telegram, chatId, sessionId, promptText, now });
      return false;
    }
    await telegram.sendMessage(
      chatId,
      res.errorCode === "session_busy" ? "Antigravity 会话当前正在执行任务，请稍后重试。" : "Antigravity 未能接收本次回答，请稍后重试或在 Web 控制台中查看。",
    );
    return false;
  };

  if (action === "q.force_submit") {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const promptText = typeof payload.promptText === "string" ? payload.promptText : "";
    await telegram.answerCallbackQuery(callbackId).catch(() => undefined);
    if (sessionId && promptText) await submitAnswer(sessionId, promptText, true);
    return;
  }

  if (action === "q.pick" && payload.immediate === true) {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const optIndex = typeof payload.optIndex === "number" ? payload.optIndex : -1;
    const meta = sourceMessageId !== undefined ? readValidState<QuestionMetaRecord>(tgStore, `qmeta:${chatKey}:${sourceMessageId}`, now) : null;
    const chosen = meta?.questions[0]?.options?.[optIndex] ?? "";
    await telegram.answerCallbackQuery(callbackId).catch(() => undefined);
    if (sessionId && chosen) {
      const ok = await submitAnswer(sessionId, chosen, false);
      if (!ok && sourceMessageId !== undefined && meta?.questions[0]) {
        const fresh = buildSingleQuestionButtons(tgStore, chatKey, sessionId, meta.questions[0], [], now);
        await telegram.editMessageReplyMarkup(chatId, sourceMessageId, fresh).catch(() => undefined);
      }
    }
    return;
  }

  if (sourceMessageId === undefined) {
    await telegram.answerCallbackQuery(callbackId, "消息上下文缺失").catch(() => undefined);
    return;
  }
  const wizKey = `qwiz:${chatKey}:${sourceMessageId}`;
  const wiz = readValidState<QuestionWizardRecord>(tgStore, wizKey, now);
  if (!wiz) {
    await telegram.answerCallbackQuery(callbackId, "问题向导已过期，请直接回复消息").catch(() => undefined);
    return;
  }
  const refreshWizardMarkup = async () => {
    tgStore.setState(wizKey, wiz, now + QUESTION_STATE_TTL_MS, now);
    await telegram.editMessageReplyMarkup(chatId, sourceMessageId, buildWizardButtons(tgStore, chatKey, wiz, [], now)).catch(() => undefined);
  };

  if (action === "q.page") {
    wiz.page = Math.min(Math.max(0, typeof payload.page === "number" ? payload.page : wiz.page), wiz.questions.length - 1);
    await telegram.answerCallbackQuery(callbackId).catch(() => undefined);
    await refreshWizardMarkup();
    return;
  }
  if (action === "q.pick") {
    const qIndex = typeof payload.qIndex === "number" ? payload.qIndex : wiz.page;
    const optIndex = typeof payload.optIndex === "number" ? payload.optIndex : -1;
    if (qIndex >= 0 && qIndex < wiz.questions.length && optIndex >= 0) {
      wiz.selections[qIndex] = [optIndex];
      if (qIndex + 1 < wiz.questions.length && (wiz.selections[qIndex + 1]?.length ?? 0) === 0) wiz.page = qIndex + 1;
    }
    await telegram.answerCallbackQuery(callbackId).catch(() => undefined);
    await refreshWizardMarkup();
    return;
  }
  if (action === "q.toggle") {
    const qIndex = typeof payload.qIndex === "number" ? payload.qIndex : wiz.page;
    const optIndex = typeof payload.optIndex === "number" ? payload.optIndex : -1;
    if (qIndex >= 0 && qIndex < wiz.questions.length && optIndex >= 0) {
      const current = new Set(wiz.selections[qIndex] ?? []);
      if (current.has(optIndex)) current.delete(optIndex);
      else current.add(optIndex);
      wiz.selections[qIndex] = Array.from(current).sort((a, b) => a - b);
    }
    await telegram.answerCallbackQuery(callbackId).catch(() => undefined);
    await refreshWizardMarkup();
    return;
  }
  if (action === "q.submit") {
    const missingIdx = wiz.selections.findIndex((sel) => sel.length === 0);
    if (missingIdx >= 0) {
      wiz.page = missingIdx;
      await telegram.answerCallbackQuery(callbackId, `请先选择第 ${missingIdx + 1} 题`).catch(() => undefined);
      await refreshWizardMarkup();
      return;
    }
    const answers = wiz.questions.map((q, idx) => (wiz.selections[idx] ?? []).map((i) => q.options?.[i] ?? "").filter(Boolean).join("；"));
    await telegram.answerCallbackQuery(callbackId).catch(() => undefined);
    if (!(await submitAnswer(wiz.sessionId, formatAntigravityQuestionAnswers(answers), false))) {
      await refreshWizardMarkup();
    }
  }
}

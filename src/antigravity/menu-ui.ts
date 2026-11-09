import { randomBytes } from "node:crypto";
import { redact } from "../security/redact.ts";
import type { InlineButton } from "../telegram/client.ts";
import type { CatalogItem } from "../web/sources/types.ts";
import type { AntigravityProjectRecord } from "./store.ts";
import type {
  AntigravityModelPreference,
  AntigravitySessionOrigin,
  AntigravityTelegramStore,
} from "./telegram-store.ts";

const PAGE_SIZE = 8;
const CALLBACK_TTL_MS = 15 * 60_000;
const TELEGRAM_LIMIT = 4_000;
const TITLE_LIMIT = 240;
const ANSWER_CHUNK_LIMIT = 3_400;

function token(): string {
  return randomBytes(18).toString("base64url");
}

/** Generate a single-use `agy:<token>` callback data string stored in `AntigravityTelegramStore`. */
export function createAntigravityCallback(
  store: AntigravityTelegramStore,
  chatId: string,
  action: string,
  payload: Record<string, unknown>,
  now = Date.now(),
  ttlMs = CALLBACK_TTL_MS
): string {
  const value = token();
  store.putCallback(
    {
      token: value,
      chatId,
      action,
      payload,
      expiresAt: now + ttlMs,
    },
    now
  );
  return `agy:${value}`;
}

/** Render paginated `/agy_new` project selection inline menu. */
export function renderAntigravityProjectMenu(
  projects: AntigravityProjectRecord[],
  page: number,
  chatId: string,
  store: AntigravityTelegramStore,
  now = Date.now()
): { text: string; buttons: InlineButton[][] } {
  const totalPages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const visible = projects.slice(start, start + PAGE_SIZE);
  const buttons: InlineButton[][] = visible.map((project) => [
    {
      text: `${project.name}`.slice(0, 60),
      callback_data: createAntigravityCallback(store, chatId, "new.project.select", { projectId: project.id }, now),
    },
  ]);

  const nav: InlineButton[] = [];
  if (safePage > 0) {
    nav.push({
      text: "◀️",
      callback_data: createAntigravityCallback(store, chatId, "new.project.page", { page: safePage - 1 }, now),
    });
  }
  if (safePage + 1 < totalPages) {
    nav.push({
      text: "▶️",
      callback_data: createAntigravityCallback(store, chatId, "new.project.page", { page: safePage + 1 }, now),
    });
  }
  if (nav.length > 0) buttons.push(nav);

  return {
    text:
      projects.length === 0
        ? "当前没有可用于新建 Antigravity 会话的项目。"
        : `📁 选择 Antigravity 项目（${safePage + 1}/${totalPages}）：`,
    buttons,
  };
}

/** Render `/agy_model` inline menu with separated base model selection and reasoning effort (`low`/`medium`/`high`) buttons. */
export function renderAntigravityModelMenu(
  models: CatalogItem[],
  current: AntigravityModelPreference | null,
  page: number,
  chatId: string,
  store: AntigravityTelegramStore,
  now = Date.now()
): { text: string; buttons: InlineButton[][] } {
  const totalPages = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const visible = models.slice(start, start + PAGE_SIZE);

  const buttons: InlineButton[][] = [
    [
      {
        text: current ? "跟随 Antigravity 默认模型" : "✓ 跟随 Antigravity 默认模型",
        callback_data: createAntigravityCallback(store, chatId, "model.default", {}, now),
      },
    ],
  ];

  for (const item of visible) {
    const isSelected = current?.modelId === item.id;
    buttons.push([
      {
        text: `${isSelected ? "✓ " : ""}${item.name}`.slice(0, 60),
        callback_data: createAntigravityCallback(
          store,
          chatId,
          "model.select",
          {
            modelId: item.id,
            reasoningEffort: item.defaultReasoningEffort ?? null,
          },
          now
        ),
      },
    ]);
  }

  const activeModel = current ? models.find((m) => m.id === current.modelId) ?? null : models[0] ?? null;
  const supportedEfforts = activeModel?.supportedReasoningEfforts ?? [];
  const activeEffort =
    supportedEfforts.length > 0
      ? current?.reasoningEffort && supportedEfforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : activeModel?.defaultReasoningEffort ?? supportedEfforts[0]!
      : null;

  if (activeModel && supportedEfforts.length > 0) {
    const effortRow: InlineButton[] = supportedEfforts.map((effort) => ({
      text: `${activeEffort === effort ? "✓ " : ""}思考等级: ${effort}`,
      callback_data: createAntigravityCallback(
        store,
        chatId,
        "model.effort",
        { modelId: activeModel.id, reasoningEffort: effort },
        now
      ),
    }));
    buttons.push(effortRow);
  }

  const nav: InlineButton[] = [];
  if (safePage > 0) {
    nav.push({
      text: "◀️",
      callback_data: createAntigravityCallback(store, chatId, "model.page", { page: safePage - 1 }, now),
    });
  }
  if (safePage + 1 < totalPages) {
    nav.push({
      text: "▶️",
      callback_data: createAntigravityCallback(store, chatId, "model.page", { page: safePage + 1 }, now),
    });
  }
  if (nav.length > 0) buttons.push(nav);

  const modelLabel = current
    ? activeModel?.name ?? current.modelId
    : `跟随 Antigravity 默认（${models[0]?.name ?? "默认"}）`;
  const effortLabel =
    supportedEfforts.length > 0
      ? activeEffort ?? "medium"
      : current
        ? "固定（不可调）"
        : models[0]?.defaultReasoningEffort ?? "默认";

  return {
    text: [
      "🤖 Antigravity 新建会话模型与思考等级：",
      `当前模型：${modelLabel}`,
      `思考等级：${effortLabel}`,
      `页面：${safePage + 1}/${totalPages}`,
      "",
      "模型与思考等级（Effort）将在新建托管会话时通过 ACP configOptions 应用。",
    ].join("\n"),
    buttons,
  };
}

function safeTitle(title?: string): string {
  const value = typeof title === "string" && title.trim() ? String(redact(title.trim())) : "会话";
  return value.length <= TITLE_LIMIT ? value : value.slice(0, TITLE_LIMIT - 1) + "…";
}

function safeBoundary(text: string, proposedEnd: number): number {
  if (proposedEnd <= 0 || proposedEnd >= text.length) return proposedEnd;
  const before = text.charCodeAt(proposedEnd - 1);
  const after = text.charCodeAt(proposedEnd);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
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

function statusLabel(kind: string): string {
  if (kind === "completed" || kind === "end_turn") return "执行完成";
  if (kind === "cancelled") return "执行已中断";
  if (kind === "incomplete" || kind === "max_tokens" || kind === "max_turn_requests") {
    return "达到输出或轮次上限，可继续发送消息";
  }
  if (kind === "failed" || kind === "refusal") return "执行失败或被拒绝";
  return "轮次已结束";
}

/** Format and split a redacted Antigravity terminal notification for Telegram delivery. */
export function formatAntigravityTerminal(
  eventKind: string,
  title?: string,
  assistantText?: string | null,
  origin: AntigravitySessionOrigin = "sea_bridge",
  desktopWritable = false
): { eventKind: string; parts: string[] } {
  const displayTitle = safeTitle(title);
  const sourcePrefix =
    origin === "desktop" ? (desktopWritable ? "Antigravity 桌面端" : "Antigravity 桌面端（只读）") : "Antigravity (Sea-Bridge)";
  const header = `${sourcePrefix}: ${displayTitle}\n状态: ${statusLabel(eventKind)}`;
  const answer = typeof assistantText === "string" ? String(redact(assistantText)) : "";
  const chunks = splitAnswer(answer);
  if (chunks.length === 0) {
    return { eventKind, parts: [header] };
  }

  const parts = chunks.map((chunk, index) => {
    const prefix =
      index === 0
        ? `${header}\n\n回答:\n`
        : `${sourcePrefix}: ${displayTitle}\n回答（${index + 1}/${chunks.length}）:\n`;
    const message = prefix + chunk;
    if (message.length > TELEGRAM_LIMIT) {
      throw new Error("antigravity_notification_chunk_exceeds_telegram_limit");
    }
    return message;
  });
  return { eventKind, parts };
}

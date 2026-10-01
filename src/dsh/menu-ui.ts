import { randomBytes } from "node:crypto";
import type { DshBridgeStore } from "../state/dsh-bridge-store.ts";
import type { InlineButton } from "../telegram/client.ts";
import type { DshModelSelection, DshProject } from "./types.ts";
import type { DshModelChoice } from "./new-session-manager.ts";

const PAGE_SIZE = 8;
const CALLBACK_TTL_MS = 15 * 60_000;

function token(): string {
  return randomBytes(18).toString("base64url");
}

export function createDshCallback(
  store: DshBridgeStore,
  chatId: string,
  action: string,
  payload: Record<string, unknown>,
  now = Date.now(),
  ttlMs = CALLBACK_TTL_MS,
): string {
  const value = token();
  store.putCallback({
    token: value,
    chatId,
    action,
    payload,
    expiresAt: now + ttlMs,
  }, now);
  return `dsh:${value}`;
}

export function renderDshProjectMenu(
  projects: DshProject[],
  page: number,
  chatId: string,
  store: DshBridgeStore,
  now = Date.now(),
): { text: string; buttons: InlineButton[][] } {
  const totalPages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const visible = projects.slice(start, start + PAGE_SIZE);
  const buttons = visible.map((project) => [{
    text: `${project.title}（${project.sessionCount}）`.slice(0, 60),
    callback_data: createDshCallback(store, chatId, "new.project.select", { projectId: project.id }, now),
  }]);
  const nav: InlineButton[] = [];
  if (safePage > 0) {
    nav.push({
      text: "◀️",
      callback_data: createDshCallback(store, chatId, "new.project.page", { page: safePage - 1 }, now),
    });
  }
  if (safePage + 1 < totalPages) {
    nav.push({
      text: "▶️",
      callback_data: createDshCallback(store, chatId, "new.project.page", { page: safePage + 1 }, now),
    });
  }
  if (nav.length) buttons.push(nav);
  return {
    text: projects.length === 0
      ? "当前没有可用于新建 dsh 会话的项目。"
      : `📁 选择 dsh Web 项目（${safePage + 1}/${totalPages}）：`,
    buttons,
  };
}

function selected(selection: DshModelSelection | null, choice: DshModelChoice): boolean {
  return selection?.provider === choice.provider && selection.model === choice.model;
}

export function renderDshModelMenu(
  choices: DshModelChoice[],
  current: DshModelSelection | null,
  hostDefault: DshModelSelection,
  page: number,
  chatId: string,
  store: DshBridgeStore,
  now = Date.now(),
): { text: string; buttons: InlineButton[][] } {
  const totalPages = Math.max(1, Math.ceil(choices.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const visible = choices.slice(start, start + PAGE_SIZE);
  const buttons: InlineButton[][] = [[{
    text: current ? "使用 Host 默认模型" : "✓ 使用 Host 默认模型",
    callback_data: createDshCallback(store, chatId, "model.default", {}, now),
  }]];
  for (const choice of visible) {
    buttons.push([{
      text: `${selected(current, choice) ? "✓ " : ""}${choice.providerName} / ${choice.name}`.slice(0, 60),
      callback_data: createDshCallback(store, chatId, "model.select", {
        provider: choice.provider,
        model: choice.model,
      }, now),
    }]);
  }
  const nav: InlineButton[] = [];
  if (safePage > 0) {
    nav.push({
      text: "◀️",
      callback_data: createDshCallback(store, chatId, "model.page", { page: safePage - 1 }, now),
    });
  }
  if (safePage + 1 < totalPages) {
    nav.push({
      text: "▶️",
      callback_data: createDshCallback(store, chatId, "model.page", { page: safePage + 1 }, now),
    });
  }
  if (nav.length) buttons.push(nav);
  const effective = current
    ? `${current.provider} / ${current.model}`
    : `Host 默认：${hostDefault.provider} / ${hostDefault.model}`;
  return {
    text: [
      "🤖 dsh Web 新建会话模型：",
      `当前选择：${effective}`,
      `页面：${safePage + 1}/${totalPages}`,
      "",
      "模型会在新 session 创建后、第一轮 prompt 前应用。",
      "注意：dsh 0.1.7-rc.2 的 selectModel 同时会保存 Host 默认模型；后续 Web 新会话也可能继承该默认值。",
    ].join("\n"),
    buttons,
  };
}

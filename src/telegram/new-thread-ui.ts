import type { ModelOption, ProjectItem } from "../desktop/codex-app-server-client.ts";
import type { InlineButton } from "./client.ts";

const PROJECTS_PER_PAGE = 8;

export interface TelegramMenu {
  text: string;
  buttons: InlineButton[][];
}

export function renderProjectPage(projects: ProjectItem[], requestedPage: number): TelegramMenu {
  const pageCount = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const start = page * PROJECTS_PER_PAGE;
  const items = projects.slice(start, start + PROJECTS_PER_PAGE);

  const buttons: InlineButton[][] = items.map((project) => [{
    text: `[${project.index}] ${project.name}`,
    callback_data: `new:proj:${project.id}`,
  }]);

  const navigation: InlineButton[] = [];
  if (page > 0) navigation.push({ text: "⬅️ 上一页", callback_data: `new:page:${page - 1}` });
  navigation.push({ text: `${page + 1}/${pageCount}`, callback_data: "new:noop" });
  if (page + 1 < pageCount) navigation.push({ text: "下一页 ➡️", callback_data: `new:page:${page + 1}` });
  buttons.push(navigation);
  buttons.push([{ text: "取消", callback_data: "new:cancel" }]);

  return {
    text: projects.length > 0
      ? `请选择要在哪个项目下新建会话（${projects.length} 个项目）：`
      : "当前没有可用于新建会话的 Codex 项目。",
    buttons,
  };
}

export function renderModelMenu(models: ModelOption[], selectedModel: string | null): TelegramMenu {
  const buttons: InlineButton[][] = [[{
    text: selectedModel == null ? "🔘 跟随 Codex 默认" : "⚪️ 跟随 Codex 默认",
    callback_data: "model:default",
  }]];

  for (const model of models) {
    buttons.push([{
      text: model.id === selectedModel ? `🔘 ${model.displayName}` : `⚪️ ${model.displayName}`,
      callback_data: `model:set:${model.id}`,
    }]);
  }
  buttons.push([{ text: "关闭", callback_data: "model:close" }]);

  return {
    text: selectedModel == null
      ? "模型偏好：跟随 Codex 默认"
      : `模型偏好：${selectedModel}`,
    buttons,
  };
}

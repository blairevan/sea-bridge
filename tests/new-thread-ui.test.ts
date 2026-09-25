import { describe, expect, test } from "bun:test";
import { renderModelMenu, renderProjectPage } from "../src/telegram/new-thread-ui.ts";

describe("new-thread Telegram UI", () => {
  test("renders projects eight per page with navigation", () => {
    const projects = Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      id: "p" + (i + 1),
      name: "project-" + (i + 1),
      roots: ["/p/" + (i + 1)],
      primaryRoot: "/p/" + (i + 1),
      position: i,
    }));

    const page = renderProjectPage(projects, 0);
    expect(page.buttons.flat().filter((b) => b.callback_data.startsWith("new:proj:"))).toHaveLength(8);
    expect(page.buttons.flat().some((b) => b.callback_data === "new:page:1")).toBe(true);

    const page2 = renderProjectPage(projects, 1);
    expect(page2.buttons.flat().filter((b) => b.callback_data.startsWith("new:proj:"))).toHaveLength(2);
    expect(page2.buttons.flat().some((b) => b.callback_data === "new:page:0")).toBe(true);
  });

  test("renders Codex default and selected model", () => {
    const menu = renderModelMenu([
      { id: "gpt-5-codex", displayName: "GPT-5 Codex" },
      { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
    ], "gpt-5.3-codex");

    expect(menu.buttons[0]?.[0]?.callback_data).toBe("model:default");
    expect(menu.buttons.flat().find((b) => b.callback_data === "model:set:gpt-5.3-codex")?.text).toContain("🔘");
  });
});

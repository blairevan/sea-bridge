import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

test("session status presents uncertainty and last confirmed context consistently", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  const ui = runInNewContext(script.slice(0, boundary) + "\n({ sessionStateLabel })", {
    document: { cookie: "" },
  }) as { sessionStateLabel: (session: { state: string; stateConfirmation?: { phase: string; lastKnownState?: string } }) => string };
  expect(ui.sessionStateLabel({ state: "unknown", stateConfirmation: { phase: "checking" } })).toBe("正在确认");
  expect(ui.sessionStateLabel({ state: "unknown", stateConfirmation: { phase: "unavailable", lastKnownState: "idle" } })).toBe("暂无法确认 · 上次为空闲");
  expect(ui.sessionStateLabel({ state: "running" })).toBe("执行中");
  expect(ui.sessionStateLabel({ state: "waiting_external_approval" })).toBe("等待 Telegram 审批");
});

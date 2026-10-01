import { expect, test } from "bun:test";
import { formatDshCompletion, formatDshTerminal } from "../src/dsh/notification-formatter.ts";

test("dsh completion message uses a source label, redacts title and respects Telegram bounds", () => {
  expect(formatDshCompletion()).toBe("dsh Web: 会话\n状态: 执行完成");
  const text = formatDshCompletion(`Bearer private-token ${"A".repeat(5_000)}`);
  expect(text).toContain("dsh Web:");
  expect(text).not.toContain("private-token");
  expect(text.length).toBeLessThanOrEqual(4_000);
});

test("dsh terminal notification includes the complete redacted answer across ordered Telegram chunks", () => {
  const original = [
    "第一段\n",
    "Bearer super-secret-token\n",
    "🙂".repeat(2_000),
    "\n最后一段",
  ].join("");
  const formatted = formatDshTerminal("completed", "测试会话", original);
  expect(formatted.parts.length).toBeGreaterThan(1);
  expect(formatted.parts[0]).toContain("dsh Web: 测试会话");
  expect(formatted.parts[0]).toContain("状态: 执行完成");
  expect(formatted.parts.every((part) => part.length <= 4_000)).toBe(true);
  expect(formatted.parts.join("")).not.toContain("super-secret-token");

  const body = formatted.parts.map((part, index) => {
    const marker = index === 0 ? "\n\n回答:\n" : `\n回答（${index + 1}/${formatted.parts.length}）:\n`;
    return part.slice(part.indexOf(marker) + marker.length);
  }).join("");
  expect(body).toBe(String(original).replace("Bearer super-secret-token", "Bearer [REDACTED]"));
  expect(body).toContain("🙂".repeat(2_000));
});

test("dsh terminal status remains useful when a turn has no visible assistant text", () => {
  const formatted = formatDshTerminal("interrupted", "会话标题", "");
  expect(formatted.parts).toEqual(["dsh Web: 会话标题\n状态: 执行已中断"]);
});

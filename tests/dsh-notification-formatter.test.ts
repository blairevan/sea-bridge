import { expect, test } from "bun:test";
import { formatDshCompletion } from "../src/dsh/notification-formatter.ts";

test("dsh completion message uses a source label, redacts title and respects Telegram bounds", () => {
  expect(formatDshCompletion()).toBe("dsh Web: 会话\n状态: 执行完成");
  const text = formatDshCompletion(`Bearer private-token ${"A".repeat(5_000)}`);
  expect(text).toContain("dsh Web:");
  expect(text).not.toContain("private-token");
  expect(text.length).toBeLessThanOrEqual(4_000);
});

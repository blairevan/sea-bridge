import { describe, expect, test } from "bun:test";
import { isAuthorized } from "../src/security/auth.ts";
import { redactedJson } from "../src/security/redact.ts";

describe("security helpers", () => {
  test("requires both user and chat identity", () => {
    expect(isAuthorized({ userId: "1", chatId: "2" }, "1", "2")).toBe(true);
    expect(isAuthorized({ userId: "1", chatId: "3" }, "1", "2")).toBe(false);
    expect(isAuthorized({ userId: "9", chatId: "2" }, "1", "2")).toBe(false);
  });

  test("redacts secret-shaped fields and bearer tokens", () => {
    const text = redactedJson({ token: "abc", nested: { Authorization: "Bearer xyz", safe: "ok" } });
    expect(text).not.toContain("abc");
    expect(text).not.toContain("xyz");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("ok");
  });
});

import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { NewThreadStateStore } from "../src/state/new-thread-state-store.ts";

describe("NewThreadStateStore", () => {
  test("stores, overwrites, and clears per-chat model preference", () => {
    const state = new StateDb(":memory:");
    const store = new NewThreadStateStore(state);

    expect(store.getDefaultModel("42")).toBeNull();
    store.setDefaultModel("42", "gpt-5-codex");
    expect(store.getDefaultModel("42")).toBe("gpt-5-codex");
    store.setDefaultModel("42", "gpt-5.3-codex");
    expect(store.getDefaultModel("42")).toBe("gpt-5.3-codex");
    store.clearDefaultModel("42");
    expect(store.getDefaultModel("42")).toBeNull();

    state.close();
  });

  test("consumes a pending prompt exactly once and expires stale records", () => {
    const state = new StateDb(":memory:");
    const store = new NewThreadStateStore(state);

    store.createPendingPrompt({
      chatId: "42",
      promptMessageId: 100,
      projectId: "p1",
      projectName: "sea-bridge",
      cwd: "/repo",
      expiresAt: 2_000,
    });

    expect(store.consumePendingPrompt("42", 100, 1_000)).toEqual({
      chatId: "42",
      promptMessageId: 100,
      projectId: "p1",
      projectName: "sea-bridge",
      cwd: "/repo",
      expiresAt: 2_000,
    });
    expect(store.consumePendingPrompt("42", 100, 1_000)).toBeNull();
    expect(store.getPromptStatus("42", 100)).toBe("consumed");

    store.createPendingPrompt({
      chatId: "42",
      promptMessageId: 101,
      projectId: "p2",
      projectName: "aining",
      cwd: "/aining",
      expiresAt: 2_000,
    });
    expect(store.consumePendingPrompt("42", 101, 2_001)).toBeNull();
    expect(store.getPromptStatus("42", 101)).toBe("expired");
    expect(store.cleanupExpired(2_001)).toBeGreaterThanOrEqual(0);

    state.close();
  });
});

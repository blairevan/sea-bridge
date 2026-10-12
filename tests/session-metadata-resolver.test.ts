import { expect, test } from "bun:test";
import { resolveSessionMetadata } from "../src/desktop/session-metadata-resolver.ts";

test("session metadata resolves fields independently without inventing defaults", () => {
  expect(resolveSessionMetadata({
    thread: {
      model: "gpt-5.6",
      reasoningEffort: "high",
      sandboxPolicy: "workspace-write",
      approvalMode: "on-request",
    },
  })).toEqual({
    model: "gpt-5.6",
    reasoningEffort: "high",
    executionPolicy: { sandbox: "workspace_write", approval: "on_request" },
  });

  expect(resolveSessionMetadata({
    thread: { model: "gpt-5.6", reasoningEffort: null, sandboxPolicy: null, approvalMode: null },
  })).toEqual({ model: "gpt-5.6" });
});

test("fresh hook model overrides the snapshot while stale hook evidence does not", () => {
  const thread = { model: "snapshot-model", reasoningEffort: "medium", sandboxPolicy: null, approvalMode: null };
  expect(resolveSessionMetadata({
    thread,
    hook: { model: "live-model", metadataObservedAt: 200 },
    hookFreshAfter: 100,
  })).toMatchObject({ model: "live-model", reasoningEffort: "medium" });
  expect(resolveSessionMetadata({
    thread,
    hook: { model: "stale-model", metadataObservedAt: 50 },
    hookFreshAfter: 100,
  })).toMatchObject({ model: "snapshot-model", reasoningEffort: "medium" });
});

test("owned action metadata is strongest for the active turn and unknown policy values stay absent", () => {
  expect(resolveSessionMetadata({
    thread: {
      model: "snapshot-model",
      reasoningEffort: "high",
      sandboxPolicy: "future-sandbox",
      approvalMode: "future-approval",
    },
    hook: { model: "hook-model", metadataObservedAt: 200 },
    action: { model: "owned-model", sandbox: "danger-full-access", approvalPolicy: "never" },
  })).toEqual({
    model: "owned-model",
    reasoningEffort: "high",
    executionPolicy: { sandbox: "danger_full_access", approval: "never" },
  });

  expect(resolveSessionMetadata({
    thread: { model: null, reasoningEffort: null, sandboxPolicy: "future-sandbox", approvalMode: "future-approval" },
  })).toBeNull();
});

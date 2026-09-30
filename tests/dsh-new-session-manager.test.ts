import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshNewSessionManager } from "../src/dsh/new-session-manager.ts";

function setup(overrides: Partial<Record<string, any>> = {}) {
  const state = new StateDb(":memory:");
  const store = new DshBridgeStore(state);
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const host = {
    health: async () => ({ status: "mounted" as const, protocol: 1, connectorVersion: "0.3.0" }),
    listProjects: async () => [
      { id: "p1", title: "Alpha", sessionCount: 1 },
      { id: "p2", title: "Duplicate", sessionCount: 2 },
      { id: "p3", title: "Duplicate", sessionCount: 3 },
    ],
    listModels: async () => ({
      default: { provider: "prov", model: "m1" },
      groups: [{ id: "prov", name: "Provider", models: [
        { id: "m1", name: "Model 1" },
        { id: "m2", name: "Model 2" },
      ] }],
      failureCount: 0,
    }),
    createSession: async (...args: unknown[]) => {
      calls.push({ op: "create", args });
      return { status: "accepted" as const, sessionId: args[1] as string, agentPreset: null };
    },
    selectModel: async (...args: unknown[]) => {
      calls.push({ op: "model", args });
      return { status: "accepted" as const, selected: args[1] as any };
    },
    submitPrompt: async (...args: unknown[]) => {
      calls.push({ op: "prompt", args });
      return { status: "accepted" as const };
    },
    ...overrides,
  };
  const manager = new DshNewSessionManager(host as any, store, () => 1_000);
  return { state, store, calls, host, manager };
}

describe("DshNewSessionManager", () => {
  test("finds projects by index/id/unique title and refuses ambiguous title", async () => {
    const { state, manager } = setup();
    expect((await manager.findProject("1"))?.id).toBe("p1");
    expect((await manager.findProject("p2"))?.id).toBe("p2");
    expect((await manager.findProject("Alpha"))?.id).toBe("p1");
    expect(await manager.findProject("Duplicate")).toBeNull();
    state.close();
  });

  test("keeps model preference isolated and detects stale saved model", async () => {
    const { state, store, manager } = setup();
    state.db.query(
      "INSERT INTO user_preferences(telegram_chat_id,key,value,updated_at) VALUES (?,?,?,?)",
    ).run("42", "default_model", "codex-model", 1);

    manager.setDefaultModel("42", { provider: "prov", model: "m2" });
    expect(manager.getDefaultModel("42")).toEqual({ provider: "prov", model: "m2" });
    expect(await manager.validateSavedModel("42")).toEqual({ provider: "prov", model: "m2" });
    expect(state.db.query(
      "SELECT value FROM user_preferences WHERE telegram_chat_id='42' AND key='default_model'",
    ).get()).toEqual({ value: "codex-model" });

    store.setDefaultModel("42", JSON.stringify({ provider: "prov", model: "missing" }));
    expect(await manager.validateSavedModel("42")).toBe("stale");
    state.close();
  });

  test("creates a stable session, applies saved model, registers baseline, and submits first prompt once", async () => {
    const { state, store, calls, manager } = setup();
    manager.setDefaultModel("42", { provider: "prov", model: "m2" });

    const created = await manager.create(100, "42", "p1", "first prompt");
    expect(created).toMatchObject({
      status: "accepted",
      project: { id: "p1", title: "Alpha", sessionCount: 1 },
      model: { provider: "prov", model: "m2" },
    });
    if (created.status !== "accepted") throw new Error("expected accepted creation");
    const sessionId = created.sessionId;
    expect(sessionId).toMatch(/^session-sea-bridge-[a-f0-9]{24}$/);
    expect(calls).toEqual([
      { op: "create", args: ["p1", sessionId] },
      { op: "model", args: [sessionId, { provider: "prov", model: "m2" }] },
      { op: "prompt", args: [sessionId, "sea-bridge-new-100", "first prompt"] },
    ]);
    expect(store.getCreatedSession(sessionId)?.baselinePending).toBe(true);
    expect(store.getCreation(100)?.status).toBe("accepted");

    expect(await manager.create(100, "42", "p1", "first prompt")).toMatchObject({
      status: "accepted",
      sessionId,
    });
    expect(calls).toHaveLength(3);

    expect(manager.acknowledge(100, "42", 900, sessionId)).toBe(true);
    expect(store.getCreation(100)?.status).toBe("acknowledged");
    expect(store.findMessageLink("42", 900)?.sessionId).toBe(sessionId);
    state.close();
  });

  test("recovers an accepted creation without rediscovery or replay", async () => {
    const first = setup();
    const created = await first.manager.create(105, "42", "p1", "prompt");
    if (created.status !== "accepted") throw new Error("expected accepted creation");
    const sessionId = created.sessionId;
    expect(first.calls.map((call) => call.op)).toEqual(["create", "prompt"]);

    const manager = new DshNewSessionManager({
      health: async () => { throw new Error("host unavailable"); },
      listProjects: async () => { throw new Error("host unavailable"); },
      listModels: async () => { throw new Error("host unavailable"); },
      createSession: async () => { throw new Error("must not replay create"); },
      selectModel: async () => { throw new Error("must not replay model"); },
      submitPrompt: async () => { throw new Error("must not replay prompt"); },
    } as any, first.store, () => 2_000);

    expect(await manager.create(105, "42", "p1", "prompt")).toMatchObject({
      status: "accepted",
      sessionId,
    });
    expect(first.calls.map((call) => call.op)).toEqual(["create", "prompt"]);
    first.state.close();
  });

  test("uses Host default when no dsh model preference exists", async () => {
    const { state, calls, manager } = setup();
    expect((await manager.create(101, "42", "p1", "prompt")).status).toBe("accepted");
    expect(calls.map((call) => call.op)).toEqual(["create", "prompt"]);
    state.close();
  });

  test("fails before side effects for stale project/model and mismatched duplicate payload", async () => {
    const { state, store, calls, manager } = setup();
    expect(await manager.create(102, "42", "missing", "prompt")).toEqual({
      status: "failed",
      errorCode: "project_missing",
    });
    manager.setDefaultModel("42", { provider: "prov", model: "missing" });
    expect(await manager.create(103, "42", "p1", "prompt")).toEqual({
      status: "failed",
      errorCode: "model_unavailable",
    });
    expect(calls).toHaveLength(0);

    manager.setDefaultModel("42", null);
    store.beginCreation(104, "p1", null, "different-hash", 1_000);
    expect(await manager.create(104, "42", "p1", "prompt")).toEqual({
      status: "failed",
      errorCode: "duplicate_payload_mismatch",
    });
    expect(calls).toHaveLength(0);
    state.close();
  });

  test("never replays after ambiguous create, model, or prompt dispatch", async () => {
    {
      let calls = 0;
      const { state, store, manager } = setup({
        createSession: async () => {
          calls++;
          throw new Error("lost");
        },
      });
      const outcome = await manager.create(110, "42", "p1", "prompt");
      expect(outcome).toMatchObject({ status: "delivery_unknown" });
      if (outcome.status !== "delivery_unknown") throw new Error("expected ambiguous creation");
      expect(outcome.sessionId).toMatch(/^session-sea-bridge-[a-f0-9]{24}$/);
      expect(store.getCreation(110)?.status).toBe("delivery_unknown");
      await manager.create(110, "42", "p1", "prompt");
      expect(calls).toBe(1);
      state.close();
    }

    {
      let modelCalls = 0;
      const { state, store, manager } = setup({
        selectModel: async () => {
          modelCalls++;
          throw new Error("lost");
        },
      });
      manager.setDefaultModel("42", { provider: "prov", model: "m2" });
      const outcome = await manager.create(111, "42", "p1", "prompt");
      expect(outcome).toMatchObject({ status: "delivery_unknown" });
      if (outcome.status !== "delivery_unknown" || !outcome.sessionId) throw new Error("expected ambiguous creation");
      expect(outcome.sessionId).toMatch(/^session-sea-bridge-[a-f0-9]{24}$/);
      expect(store.getCreatedSession(outcome.sessionId)?.baselinePending).toBe(true);
      await manager.create(111, "42", "p1", "prompt");
      expect(modelCalls).toBe(1);
      state.close();
    }

    {
      let promptCalls = 0;
      const { state, store, manager } = setup({
        submitPrompt: async () => {
          promptCalls++;
          throw new Error("lost");
        },
      });
      const outcome = await manager.create(112, "42", "p1", "prompt");
      expect(outcome).toMatchObject({ status: "delivery_unknown" });
      if (outcome.status !== "delivery_unknown") throw new Error("expected ambiguous creation");
      expect(outcome.sessionId).toMatch(/^session-sea-bridge-[a-f0-9]{24}$/);
      expect(store.getCreation(112)?.status).toBe("delivery_unknown");
      await manager.create(112, "42", "p1", "prompt");
      expect(promptCalls).toBe(1);
      state.close();
    }
  });

  test("a rejected create is proven side-effect-free, while post-create failure remains ambiguous", async () => {
    {
      const { state, store, manager } = setup({
        createSession: async () => ({ status: "rejected" as const, errorCode: "project_missing" }),
      });
      expect(await manager.create(120, "42", "p1", "prompt")).toEqual({
        status: "failed",
        errorCode: "project_missing",
      });
      expect(store.getCreation(120)?.status).toBe("failed");
      state.close();
    }

    {
      const { state, store, manager } = setup({
        submitPrompt: async () => ({ status: "busy_or_writer_held" as const, errorCode: "session/agent-busy" }),
      });
      const outcome = await manager.create(121, "42", "p1", "prompt");
      expect(outcome).toMatchObject({ status: "delivery_unknown" });
      if (outcome.status !== "delivery_unknown") throw new Error("expected ambiguous creation");
      expect(outcome.sessionId).toMatch(/^session-sea-bridge-[a-f0-9]{24}$/);
      expect(store.getCreation(121)?.status).toBe("delivery_unknown");
      state.close();
    }
  });

  test("fails closed if a created session marker belongs to another creation", async () => {
    const { state, store, calls, manager } = setup({
      createSession: async (...args: unknown[]) => {
        calls.push({ op: "create", args });
        return { status: "accepted" as const, sessionId: "session-collision", agentPreset: null };
      },
    });
    store.registerCreatedSession("session-collision", 999, 1);
    const outcome = await manager.create(130, "42", "p1", "prompt");
    expect(outcome).toEqual({
      status: "delivery_unknown",
      errorCode: "created_session_marker_conflict",
      sessionId: "session-collision",
    });
    expect(calls.map((call) => call.op)).toEqual(["create"]);
    expect(store.getCreation(130)).toMatchObject({
      status: "delivery_unknown",
      errorCode: "created_session_marker_conflict",
    });
    state.close();
  });

  test("pending new-session prompt is durable, expiring and single-use", () => {
    const { state, manager } = setup();
    manager.createPendingPrompt("42", 500, "p1", 100);
    expect(manager.consumePendingPrompt("42", 500)).toEqual({
      chatId: "42",
      promptMessageId: 500,
      projectId: "p1",
      expiresAt: 1_100,
    });
    expect(manager.consumePendingPrompt("42", 500)).toBeNull();
    expect(manager.getPendingPromptStatus("42", 500)).toBe("consumed");
    state.close();
  });
});

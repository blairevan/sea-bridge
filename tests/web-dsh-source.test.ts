import { expect, test } from "bun:test";
import { DshWebSource } from "../src/web/sources/dsh.ts";
import type { DshWebHostClient } from "../src/dsh/web-host-client.ts";
import type { DshWriteResult } from "../src/dsh/types.ts";

test("dsh Web gates, history limitations, request-local model and unknown writes", async () => {
  const calls: string[] = []; let transportLost = false; let running = false; let result: DshWriteResult = { status: "accepted" }; let summaryCalls = 0;
  const host: Pick<DshWebHostClient, "health" | "listSessions" | "listProjects" | "listModels" | "followSnapshot" | "pageHistory" | "getTurnSummary" | "createSession" | "selectModel" | "submitPrompt"> = {
    async health() { return { status: "mounted", protocol: 1, connectorVersion: "0.4.0" }; },
    async listSessions() { return [{ sessionId: "session-example", title: "fixture", running, blank: false, updatedAt: 1 }]; },
    async listProjects() { return [{ id: "project", title: "fixture", sessionCount: 1 }]; },
    async listModels() { return { default: { provider: "provider", model: "model" }, failureCount: 0, groups: [{ id: "provider", name: "fixture", models: [{ id: "model", name: "fixture" }] }] }; },
    async followSnapshot() { return { cursor: 3, hasMore: false, truncated: false, events: [] }; },
    async pageHistory() { return { hasMore: false, truncated: false, events: [{ type: "turn/end", seq: 3, time: 1, turn: 1, reasonKind: "completed" }] }; },
    async getTurnSummary() { summaryCalls++; return { turn: 1, assistantSeq: 2, assistantText: "fixture reply" }; },
    async createSession(_project, id) { calls.push("create:" + id); return { status: "accepted", sessionId: id, agentPreset: null }; },
    async selectModel(_session, selected) { calls.push("model:" + selected.model); return { status: "accepted", selected }; },
    async submitPrompt(_session, id, text) { if (transportLost) throw new Error("offline"); calls.push(id + ":" + text); return result; },
  };
  const readonly = new DshWebSource(host, true, false);
  expect((await readonly.send("session-example", "op", "hello")).errorCode).toBe("writes_disabled");
  expect((await readonly.sessions())[0]?.projectId).toBeNull();
  expect((await readonly.history("session-example", null, 20)).messages.map((message) => message.role)).toEqual(["assistant"]);
  expect(readonly.capabilities().completeUserHistoryReadable).toBe(false);
  const disabled = new DshWebSource(host, false, false);
  await expect(disabled.sessions()).rejects.toThrow("source_disabled");
  const source = new DshWebSource(host, true, true, () => [{ id: "web-op", role: "user", text: "Web fixture prompt" }]);
  running = true;
  expect(await source.execution("session-example", null)).toEqual({ state: "running", exact: false });
  running = false;
  expect((await source.history("session-example", null, 20)).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect((await source.history("session-example", null, 20)).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(summaryCalls).toBe(2); // one call came from the separate readonly adapter above
  const model = (await source.models())[0]?.id ?? "";
  let early = "";
  const created = await source.create({ operationId: "op-create", projectId: "project", modelId: model, prompt: "hello", onSessionKnown(id) { early = id; } });
  expect(created.state).toBe("accepted"); expect(created.sessionId).toBe(early);
  expect(calls[0]).toMatch(/^create:session-sea-bridge-web-/);
  expect(calls[1]).toBe("model:model"); expect(calls[2]).toMatch(/^sea-bridge-web-.*:hello$/);
  result = { status: "busy_or_writer_held", errorCode: "busy" };
  expect((await source.send("session-example", "op-send", "follow")).state).toBe("failed");
  result = { status: "delivery_unknown", errorCode: "transport" };
  expect((await source.send("session-example", "op-send-2", "follow")).state).toBe("delivery_unknown");
  const callsBeforeValidation = calls.length;
  expect((await source.send("bad/session", "op-invalid-session", "follow")).errorCode).toBe("invalid_session");
  expect((await source.send("session-example", "op-too-long", "x".repeat(8193))).errorCode).toBe("validation_failed");
  expect((await source.create({ operationId: "too-long-create", projectId: "project", modelId: null, prompt: "x".repeat(8193), onSessionKnown() {} })).errorCode).toBe("validation_failed");
  expect(calls.length).toBe(callsBeforeValidation);
  transportLost = true;
  const unknown = await source.create({ operationId: "lost-create", projectId: "project", modelId: null, prompt: "hello", onSessionKnown() {} });
  expect(unknown.state).toBe("delivery_unknown"); expect(unknown.sessionId).toMatch(/^session-sea-bridge-web-/);
  expect(calls.every((call) => !call.includes("telegram"))).toBe(true);
});

test("dsh capabilities track sessions, projects, models, and history independently", async () => {
  const host = {
    async health() { return { status: "mounted" as const, protocol: 1, connectorVersion: "0.4.0" }; },
    async listSessions() { return [{ sessionId: "session", running: false, blank: false, updatedAt: 1 }]; },
    async listProjects() { return [{ id: "project", title: "project", sessionCount: 1 }]; },
    async listModels() { throw new Error("models offline"); },
    async followSnapshot() { return { cursor: -1, hasMore: false, truncated: false, events: [] }; },
    async pageHistory() { return { hasMore: false, truncated: false, events: [] }; },
    async getTurnSummary() { return { turn: 0, assistantSeq: null, assistantText: null }; },
    async createSession() { throw new Error("unused"); },
    async selectModel() { throw new Error("unused"); },
    async submitPrompt() { throw new Error("unused"); },
  };
  const source = new DshWebSource(host as any, true, true);
  await source.sessions();
  expect(source.capabilities()).toMatchObject({ sessionsReadable: true, projectsReadable: false, modelsReadable: false, historyReadable: false, sendEnabled: true, createEnabled: false });
  await source.projects();
  expect(source.capabilities()).toMatchObject({ projectsReadable: true, createEnabled: true });
  await expect(source.models()).rejects.toThrow("models_unavailable");
  expect(source.capabilities()).toMatchObject({ sessionsReadable: true, projectsReadable: true, modelsReadable: false, createEnabled: true });
  await source.history("session", null, 20);
  expect(source.capabilities().historyReadable).toBe(true);
});

test("dsh create preflight failures are definite and do not dispatch", async () => {
  let creates = 0;
  const host = {
    async health() { throw new Error("offline"); },
    async listSessions() { return []; },
    async listProjects() { return []; },
    async listModels() { return { default: { provider: "p", model: "m" }, failureCount: 0, groups: [] }; },
    async followSnapshot() { return { cursor: -1, hasMore: false, truncated: false, events: [] }; },
    async pageHistory() { return { hasMore: false, truncated: false, events: [] }; },
    async getTurnSummary() { return { turn: 0, assistantSeq: null, assistantText: null }; },
    async createSession() { creates++; return { status: "accepted" as const, sessionId: "unexpected", agentPreset: null }; },
    async selectModel() { throw new Error("unused"); },
    async submitPrompt() { throw new Error("unused"); },
  };
  const source = new DshWebSource(host as any, true, true);
  const result = await source.create({ operationId: "offline", projectId: "project", modelId: null, prompt: "hello", onSessionKnown() {} });
  expect(result).toMatchObject({ state: "failed", errorCode: "source_unavailable", sessionId: null });
  expect(creates).toBe(0);
});

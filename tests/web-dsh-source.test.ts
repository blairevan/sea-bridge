import { expect, test } from "bun:test";
import { DshWebSource } from "../src/web/sources/dsh.ts";
import type { DshWebHostClient } from "../src/dsh/web-host-client.ts";
import type { DshWriteResult } from "../src/dsh/types.ts";

test("dsh Web gates, history limitations, request-local model and unknown writes", async () => {
  const calls: string[] = []; let transportLost = false; let result: DshWriteResult = { status: "accepted" };
  const host: Pick<DshWebHostClient, "health" | "listSessions" | "listProjects" | "listModels" | "followSnapshot" | "pageHistory" | "getTurnSummary" | "createSession" | "selectModel" | "submitPrompt"> = {
    async health() { return { status: "mounted", protocol: 1, connectorVersion: "0.4.0" }; },
    async listSessions() { return [{ sessionId: "session-example", title: "fixture", running: false, blank: false, updatedAt: 1 }]; },
    async listProjects() { return [{ id: "project", title: "fixture", sessionCount: 1 }]; },
    async listModels() { return { default: { provider: "provider", model: "model" }, failureCount: 0, groups: [{ id: "provider", name: "fixture", models: [{ id: "model", name: "fixture" }] }] }; },
    async followSnapshot() { return { cursor: 3, hasMore: false, truncated: false, events: [] }; },
    async pageHistory() { return { hasMore: false, truncated: false, events: [{ type: "turn/end", seq: 3, time: 1, turn: 1, reasonKind: "completed" }] }; },
    async getTurnSummary() { return { turn: 1, assistantSeq: 2, assistantText: "fixture reply" }; },
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
  expect((await source.history("session-example", null, 20)).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
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
  transportLost = true;
  const unknown = await source.create({ operationId: "lost-create", projectId: "project", modelId: null, prompt: "hello", onSessionKnown() {} });
  expect(unknown.state).toBe("delivery_unknown"); expect(unknown.sessionId).toMatch(/^session-sea-bridge-web-/);
  expect(calls.every((call) => !call.includes("telegram"))).toBe(true);
});

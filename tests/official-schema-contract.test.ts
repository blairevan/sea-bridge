import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { ContinuationQueue } from "../src/state/continuation-queue.ts";
import { SessionStateStore } from "../src/desktop/session-state.ts";
import { CodexHookProvider } from "../src/desktop/providers/codex-hook.ts";
import type { Logger } from "../src/logger.ts";

const fixtureDir = join(__dirname, "fixtures/desktop/codex-hook/0.153.4");

const nullLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
};

function loadJson(name: string) {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

describe("Official Hook Schema Contract (0.153.4)", () => {
  test("official schemas exist and contain required contracts", () => {
    const schemas = loadJson("official-hook-schemas.json");
    expect(schemas["permission-request.input"]).toBeDefined();
    expect(schemas["permission-request.output"]).toBeDefined();
    expect(schemas["stop.input"]).toBeDefined();
    expect(schemas["stop.output"]).toBeDefined();

    // Verify PermissionRequest requires turn_id
    const permReq = schemas["permission-request.input"];
    expect(permReq.required).toContain("turn_id");
    expect(permReq.required).toContain("session_id");
    expect(permReq.required).toContain("hook_event_name");
    expect(permReq.required).toContain("tool_name");
    expect(permReq.required).toContain("tool_input");

    // Verify Stop requires turn_id and stop_hook_active
    const stopReq = schemas["stop.input"];
    expect(stopReq.required).toContain("turn_id");
    expect(stopReq.required).toContain("stop_hook_active");
    expect(stopReq.required).toContain("last_assistant_message");

    // Verify Stop output supports block
    const stopOut = schemas["stop.output"];
    expect(stopOut.definitions?.BlockDecisionWire?.enum).toContain("block");
  });

  test("PermissionRequest fixtures match official schema requirements", () => {
    const schemas = loadJson("official-hook-schemas.json");
    const permReqSchema = schemas["permission-request.input"];
    const inputFixture = loadJson("permission-request.input.json");

    for (const field of permReqSchema.required) {
      expect(inputFixture[field]).toBeDefined();
    }
    expect(inputFixture.hook_event_name).toBe("PermissionRequest");

    // Output allow
    const allowFixture = loadJson("permission-request.allow.output.json");
    expect(allowFixture.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(allowFixture.hookSpecificOutput.decision.behavior).toBe("allow");

    // Output deny
    const denyFixture = loadJson("permission-request.deny.output.json");
    expect(denyFixture.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(denyFixture.hookSpecificOutput.decision.behavior).toBe("deny");
  });

  test("Stop fixtures match official schema requirements", () => {
    const schemas = loadJson("official-hook-schemas.json");
    const stopReqSchema = schemas["stop.input"];
    const stopInput = loadJson("stop.input.json");

    for (const field of stopReqSchema.required) {
      expect(stopInput[field]).toBeDefined();
    }
    expect(stopInput.hook_event_name).toBe("Stop");
    expect(stopInput.stop_hook_active).toBe(false);

    // Continuation output
    const contOut = loadJson("stop.continuation.output.json");
    expect(contOut.decision).toBe("block");
    expect(typeof contOut.reason).toBe("string");
  });

  test("CodexHookProvider handles real PermissionRequest fixture and produces schema-valid allow", async () => {
    const inputFixture = loadJson("permission-request.input.json");
    const state = new StateDb(":memory:");
    const sessions = new SessionStateStore(state);
    const queue = new ContinuationQueue(state);

    // Prime session to active
    sessions.observeEvent({
      session_id: inputFixture.session_id,
      turn_id: inputFixture.turn_id,
      hook_event_name: "PreToolUse",
    });

    const provider = new CodexHookProvider(
      sessions,
      queue,
      {
        request: async () => ({ approvalId: "test-appr", decision: "allow" }),
        markDelivered() {},
        markDeliveryFailed() {},
      } as any,
      nullLogger,
      { activeSessionTtlMs: 60_000, requireFreshTranscript: false },
    );

    const result = await provider.handle({
      protocolVersion: 1,
      invocationId: "inv-001",
      sentAt: Date.now(),
      event: inputFixture,
    });

    expect(result.output).toBeDefined();
    expect((result.output as any).hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect((result.output as any).hookSpecificOutput.decision.behavior).toBe("allow");
    state.close();
  });

  test("CodexHookProvider handles real Stop fixture and produces schema-valid block continuation", async () => {
    const inputFixture = loadJson("stop.input.json");
    const state = new StateDb(":memory:");
    const sessions = new SessionStateStore(state);
    const queue = new ContinuationQueue(state);

    sessions.observeEvent({
      session_id: inputFixture.session_id,
      turn_id: inputFixture.turn_id,
      hook_event_name: "PreToolUse",
    });
    queue.enqueue(inputFixture.session_id, "schema continuation test", 1);

    const provider = new CodexHookProvider(
      sessions,
      queue,
      { request: async () => null } as any,
      nullLogger,
      { activeSessionTtlMs: 60_000, requireFreshTranscript: false },
    );

    const result = await provider.handle({
      protocolVersion: 1,
      invocationId: "inv-002",
      sentAt: Date.now(),
      event: inputFixture,
    });

    expect(result.output).toBeDefined();
    expect((result.output as any).decision).toBe("block");
    expect((result.output as any).reason).toBe("schema continuation test");
    state.close();
  });
});

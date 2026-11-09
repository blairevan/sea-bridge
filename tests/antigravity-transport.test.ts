import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AcpClient } from "../src/antigravity/client.ts";
import { AntigravityCapabilityGate } from "../src/antigravity/capabilities.ts";
import {
  parseInitializeResult,
  parsePermissionRequestParams,
  parsePromptResult,
  parseSessionSetupResult,
} from "../src/antigravity/protocol.ts";

const fixturesDir = path.join(import.meta.dir, "fixtures", "antigravity-acp");

describe("Antigravity ACP transport, protocol, and capability gate", () => {
  test("parses recorded P0 fixtures and enforces protocolVersion === 1", () => {
    const initFixture = JSON.parse(readFileSync(path.join(fixturesDir, "initialize.json"), "utf8"));
    const newFixture = JSON.parse(readFileSync(path.join(fixturesDir, "session-new.json"), "utf8"));
    const permFixture = JSON.parse(readFileSync(path.join(fixturesDir, "request-permission.json"), "utf8"));
    const promptFixture = JSON.parse(readFileSync(path.join(fixturesDir, "prompt-turn.json"), "utf8"));

    const initRes = parseInitializeResult(initFixture.response.result);
    expect(initRes.protocolVersion).toBe(1);
    expect(initRes.agentInfo?.version).toBe("1.5.2");

    const gate = new AntigravityCapabilityGate({
      enabled: true,
      writeEnabled: true,
      desktopReadEnabled: true,
    });
    const snap = gate.recordHandshake(initRes, 1000);
    expect(snap.protocolCompatible).toBe(true);
    expect(snap.loadSupported).toBe(true);
    expect(snap.resumeSupported).toBe(true);
    expect(gate.toStatusState()).toBe("limited");

    // Unsupported protocol version marks protocol_incompatible and disables writes
    gate.recordHandshake({ protocolVersion: 99 }, 2000);
    expect(gate.toStatusState()).toBe("protocol_incompatible");
    expect(gate.toWebCapabilities({ hasProjects: true, hasModels: true }).createEnabled).toBe(false);

    const setupRes = parseSessionSetupResult(newFixture.response.result);
    expect(setupRes.sessionId).toBe("9d3547fd-5f23-4178-b143-38a82ad31d85");
    expect(setupRes.configOptions?.find((c) => c.id === "model")?.currentValue).toBe("gemini-4-argon");
    expect(setupRes.configOptions?.find((c) => c.id === "thought_level")?.currentValue).toBe("medium");

    const permReq = parsePermissionRequestParams(permFixture.inboundRequest.params);
    expect(permReq.toolCall.toolCallId).toBe("call_4701422120073084829");
    expect(permReq.options.map((o) => o.optionId)).toEqual(["allow", "deny"]);

    const promptRes = parsePromptResult(promptFixture.response.result);
    expect(promptRes.stopReason).toBe("end_turn");
  });

  test("handles split UTF-8 chunks, spinner noise lines, string-id permission RPC, and session/update streaming", async () => {
    const script = `
      const decoder = new TextDecoder();
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            process.stdout.write("⠙ Spinner noise line...\\n");
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentInfo: { name: "agy", version: "1.5.2" }, agentCapabilities: { loadSession: true } }
            }) + "\\n");
          } else if (msg.method === "session/new") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                sessionId: "sess-utf8-1",
                configOptions: [
                  { id: "model", name: "Model", type: "select", currentValue: "gemini-4-argon", options: [] },
                  { id: "thought_level", name: "Thinking Level", type: "select", currentValue: "medium", options: [] }
                ]
              }
            }) + "\\n");
          } else if (msg.method === "session/prompt") {
            // Emit split multi-byte UTF-8 ("你好世界") across two writes
            const frame = Buffer.from(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "sess-utf8-1",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好世界" } }
              }
            }) + "\\n", "utf8");
            const splitIndex = frame.indexOf(Buffer.from("好", "utf8")) + 1;
            process.stdout.write(frame.subarray(0, splitIndex));
            setTimeout(() => {
              process.stdout.write(frame.subarray(splitIndex));
              // Send inbound permission request with string id "perm-1"
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: "perm-1",
                method: "session/request_permission",
                params: {
                  sessionId: "sess-utf8-1",
                  toolCall: { toolCallId: "tc-1", name: "run_command", title: "echo hi" },
                  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
                }
              }) + "\\n");
            }, 10);
          } else if (msg.id === "perm-1" && msg.result) {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              result: { stopReason: msg.result.outcome.optionId === "allow" ? "end_turn" : "cancelled" }
            }) + "\\n");
          }
        }
      });
    `;

    const updates: string[] = [];
    const permissionIds: Array<string | number> = [];

    const client = new AcpClient(
      {
        cliPath: process.execPath,
        args: ["-e", script],
        processGeneration: 7,
      },
      {
        onSessionUpdate: (u) => {
          const content = u.update.content as { text?: string } | undefined;
          if (content?.text) updates.push(content.text);
        },
        onPermissionRequest: async (id, req) => {
          permissionIds.push(id);
          expect(req.toolCall.toolCallId).toBe("tc-1");
          return { outcome: { outcome: "selected", optionId: "allow" } };
        },
      }
    );

    client.start();
    try {
      expect(client.identity().generation).toBe(7);
      expect(client.identity().pid).toBeGreaterThan(0);

      const init = await client.initialize();
      expect(init.protocolVersion).toBe(1);

      const created = await client.sessionNew("/tmp");
      expect(created.sessionId).toBe("sess-utf8-1");

      const { promise } = client.prompt("sess-utf8-1", "test utf8");
      const res = await promise;
      expect(res.stopReason).toBe("end_turn");
      expect(updates).toEqual(["你好世界"]);
      expect(permissionIds).toEqual(["perm-1"]);
    } finally {
      client.close();
    }
  });

  test("rejects oversized single frame and cleans up child process", async () => {
    const script = `
      process.stdin.on("data", () => {
        process.stdout.write("{" + "a".repeat(4096));
      });
    `;
    const client = new AcpClient({
      cliPath: process.execPath,
      args: ["-e", script],
      processGeneration: 1,
      maxFrameBytes: 1024,
    });
    client.start();
    try {
      await expect(client.initialize()).rejects.toThrow("acp_frame_too_large");
    } finally {
      client.close();
    }
  });
});

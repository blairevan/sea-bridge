import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexReadService } from "../src/desktop/codex-read-service.ts";

interface TestRpcMessage {
  id?: number;
  method?: string;
  params: Record<string, unknown>;
}

class MockProcess extends EventEmitter {
  stdin = {
    write: (data: string) => {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as TestRpcMessage;
        this.writes.push(message);
        this.onWrite(message);
      }
      return true;
    },
    end: () => queueMicrotask(() => this.emit("close", 0, null)),
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  writes: TestRpcMessage[] = [];

  constructor(private readonly onWrite: (message: TestRpcMessage) => void) {
    super();
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }

  send(message: unknown): void {
    queueMicrotask(() => this.stdout.emit("data", JSON.stringify(message) + "\n"));
  }
}

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: null,
    preview: `Preview ${id}`,
    path: `/tmp/${id}.jsonl`,
    createdAt: 10,
    updatedAt: 20,
    recencyAt: 20,
    source: "cli",
    originator: "codex-tui",
    parentThreadId: null,
    threadSource: "user",
    ...overrides,
  };
}

describe("CodexReadService", () => {
  test("reuses one initialized process and paginates the ordinary thread catalog", async () => {
    let proc!: MockProcess;
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/list") {
        expect(message.params.sourceKinds).toEqual(["cli", "vscode", "exec", "appServer", "unknown"]);
        expect(message.params.archived).toBe(false);
        expect(message.params.useStateDbOnly).toBe(true);
        return proc.send({
          id: message.id,
          result: message.params.cursor == null
            ? { data: [thread("a"), thread("sub", { parentThreadId: "parent" })], nextCursor: "next" }
            : { data: [thread("b", { originator: "Codex Desktop", source: "vscode" })], nextCursor: null },
        });
      }
      if (message.method === "thread/turns/list") {
        return proc.send({ id: message.id, result: { data: [{ id: "turn", status: "completed", startedAt: 30, completedAt: 31, itemsView: "summary" }], nextCursor: null } });
      }
    });
    const service = new CodexReadService("/codex", "/home/codex", {
      spawner: (_command, _args, env) => { envs.push(env); return proc as unknown as ChildProcessWithoutNullStreams; },
      requestTimeoutMs: 500,
    });

    const threads = await service.listThreads();
    const turns = await service.listTurns("a");

    expect(threads.map((item) => item.id)).toEqual(["a", "b"]);
    expect(threads[0]?.creationClient).toEqual({ kind: "cli", evidence: "originator" });
    expect(threads[1]?.creationClient).toEqual({ kind: "desktop", evidence: "originator" });
    expect(turns).toEqual([{ id: "turn", status: "completed", startedAtMs: 30_000, completedAtMs: 31_000, itemsView: "summary" }]);
    expect(envs).toHaveLength(1);
    expect(envs[0]?.CODEX_HOME).toBe("/home/codex");
    expect(proc.writes.filter((item) => item.method === "initialize")).toHaveLength(1);
    await service.close();
  });

  test("reads all item pages and prefers an explicit final_answer", async () => {
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/items/list") {
        return proc.send({
          id: message.id,
          result: message.params.cursor == null
            ? { data: [{ turnId: "t", item: { id: "m1", type: "agentMessage", text: "progress", phase: "commentary" } }], nextCursor: "p2" }
            : { data: [{ turnId: "t", item: { id: "m2", type: "agentMessage", text: "done", phase: "final_answer" } }], nextCursor: null },
        });
      }
    });
    const service = new CodexReadService("/codex", "/home/codex", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 500,
    });
    await expect(service.finalText("thread", "turn")).resolves.toBe("done");
    expect(proc.writes.filter((message) => message.method === "thread/items/list").every((message) => message.params.limit === 25)).toBe(true);
    await service.close();
  });

  test("never promotes phased agent messages to final text and only uses a fully phase-less legacy stream", async () => {
    let mode: "commentary" | "legacy" | "mixed" | "mixedBlank" | "mixedOversized" | "mixedNullPhase" = "commentary";
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method !== "thread/items/list") return;
      const data = mode === "commentary"
        ? [{ item: { type: "agentMessage", text: "Still working", phase: "commentary" } }]
        : mode === "legacy"
          ? [{ item: { type: "agentMessage", text: "legacy progress" } }, { item: { type: "agentMessage", text: "legacy final" } }]
          : mode === "mixedBlank"
            ? [{ item: { type: "agentMessage", text: "old candidate" } }, { item: { type: "agentMessage", text: "   ", phase: "commentary" } }]
            : mode === "mixedOversized"
              ? [{ item: { type: "agentMessage", text: "old candidate" } }, { item: { type: "agentMessage", text: "x".repeat(1_000_001), phase: "commentary" } }]
              : mode === "mixedNullPhase"
                ? [{ item: { type: "agentMessage", text: "old candidate" } }, { item: { type: "agentMessage", text: "", phase: null } }]
                : [{ item: { type: "agentMessage", text: "legacy-looking" } }, { item: { type: "agentMessage", text: "working", phase: "commentary" } }];
      proc.send({ id: message.id, result: { data, nextCursor: null } });
    });
    const service = new CodexReadService("/codex", "/home/codex", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 500,
    });

    await expect(service.finalText("thread", "turn")).resolves.toBeNull();
    mode = "legacy";
    await expect(service.finalText("thread", "turn")).resolves.toBe("legacy final");
    mode = "mixed";
    await expect(service.finalText("thread", "turn")).resolves.toBeNull();
    mode = "mixedBlank";
    await expect(service.finalText("thread", "turn")).resolves.toBeNull();
    mode = "mixedOversized";
    await expect(service.finalText("thread", "turn")).resolves.toBeNull();
    mode = "mixedNullPhase";
    await expect(service.finalText("thread", "turn")).resolves.toBeNull();
    await service.close();
  });

  test("fails closed on malformed thread wire data and stays protocol-incompatible", async () => {
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/list") return proc.send({ id: message.id, result: { data: [{ preview: "missing id" }], nextCursor: null } });
    });
    const service = new CodexReadService("/codex", "/home/codex", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 500,
    });
    await expect(service.listThreads()).rejects.toThrow("codex_thread_list_invalid_thread");
    expect(service.state).toBe("protocol_incompatible");
    const writes = proc.writes.length;
    await expect(service.listThreads()).rejects.toThrow("codex_read_service_protocol_incompatible");
    expect(proc.writes).toHaveLength(writes);
    await service.close();
  });

  test("rejects a non-string pagination cursor instead of silently truncating history", async () => {
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/turns/list") return proc.send({ id: message.id, result: { data: [], nextCursor: 123 } });
    });
    const service = new CodexReadService("/codex", "/home/codex", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 500,
    });
    await expect(service.listTurns("thread")).rejects.toThrow("codex_turn_list_invalid_cursor");
    expect(service.state).toBe("protocol_incompatible");
    await service.close();
  });

  test("does not restart for one timeout but restarts after consecutive timeouts", async () => {
    const processes: MockProcess[] = [];
    const service = new CodexReadService("/codex", "/home/codex", {
      spawner: () => {
        let proc!: MockProcess;
        proc = new MockProcess((message) => {
          if (message.method === "initialize") proc.send({ id: message.id, result: {} });
          if (message.method === "thread/list" && processes.length > 1) proc.send({ id: message.id, result: { data: [], nextCursor: null } });
        });
        processes.push(proc);
        return proc as unknown as ChildProcessWithoutNullStreams;
      },
      requestTimeoutMs: 5,
      maxConsecutiveTimeouts: 2,
      restartDelaysMs: [1],
      random: () => 0,
    });
    await expect(service.listThreadPage()).rejects.toThrow("app_server_rpc_timeout");
    expect(processes).toHaveLength(1);
    await expect(service.listThreadPage()).rejects.toThrow("app_server_rpc_timeout");
    expect(service.state).toBe("degraded");
    await Bun.sleep(5);
    await expect(service.listThreadPage()).resolves.toEqual({ data: [], nextCursor: null });
    expect(processes.length).toBeGreaterThanOrEqual(2);
    await service.close();
  });

  test("detects a repeated pagination cursor", async () => {
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/list") return proc.send({ id: message.id, result: { data: [], nextCursor: "same" } });
    });
    const service = new CodexReadService("/codex", "/home/codex", {
      spawner: () => proc as unknown as ChildProcessWithoutNullStreams,
      requestTimeoutMs: 500,
    });
    await expect(service.listThreads()).rejects.toThrow("codex_thread_list_cursor_loop");
    await service.close();
  });
});

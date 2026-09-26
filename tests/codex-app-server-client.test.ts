import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CodexAppServerClient } from "../src/desktop/codex-app-server-client.ts";

class MockProcess extends EventEmitter {
  stdin = {
    write: (data: string) => {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        this.writes.push(JSON.parse(line));
        this.onWrite(JSON.parse(line));
      }
      return true;
    },
    end: () => {
      this.stdinEnded = true;
      queueMicrotask(() => this.emit("close", 0, null));
    },
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  stdinEnded = false;
  writes: any[] = [];

  constructor(private readonly onWrite: (message: any) => void) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }

  send(message: unknown): void {
    queueMicrotask(() => this.stdout.emit("data", JSON.stringify(message) + "\n"));
  }
}

describe("CodexAppServerClient", () => {
  test("listProjects initializes first, paginates, filters rootless projects, and preserves order", async () => {
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") {
        proc.send({ id: message.id, result: {} });
        return;
      }
      if (message.method === "project/list" && message.params.cursor == null) {
        proc.send({
          id: message.id,
          result: {
            data: [
              { id: "p1", name: "sea-bridge", roots: [{ path: "/opt/app/aitools/sea-bridge" }], position: 2 },
              { id: "p2", name: "aining", roots: [{ path: "/opt/app/aining" }], position: 1 },
            ],
            nextCursor: "next",
          },
        });
        return;
      }
      if (message.method === "project/list" && message.params.cursor === "next") {
        proc.send({
          id: message.id,
          result: {
            data: [{ id: "empty", name: "empty", roots: [], position: 3 }],
            nextCursor: null,
          },
        });
      }
    });

    const client = new CodexAppServerClient("/codex", { spawner: () => proc as any, requestTimeoutMs: 500 });
    const projects = await client.listProjects();

    expect(proc.writes[0].method).toBe("initialize");
    expect(proc.writes[0].params.capabilities.experimentalApi).toBe(true);
    expect(proc.writes[1]).toEqual({ jsonrpc: "2.0", method: "initialized" });
    expect(proc.writes[2].method).toBe("project/list");
    expect(projects).toEqual([
      { index: 1, id: "p2", name: "aining", roots: ["/opt/app/aining"], primaryRoot: "/opt/app/aining", position: 1 },
      { index: 2, id: "p1", name: "sea-bridge", roots: ["/opt/app/aitools/sea-bridge"], primaryRoot: "/opt/app/aitools/sea-bridge", position: 2 },
    ]);
  });

  test("listModels returns only visible models from all pages", async () => {
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "model/list" && message.params.cursor == null) {
        return proc.send({
          id: message.id,
          result: {
            data: [
              { id: "gpt-5-codex", displayName: "GPT-5 Codex", hidden: false },
              { id: "hidden", displayName: "Hidden", hidden: true },
            ],
            nextCursor: "m2",
          },
        });
      }
      if (message.method === "model/list" && message.params.cursor === "m2") {
        return proc.send({
          id: message.id,
          result: {
            data: [{ id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", hidden: false }],
            nextCursor: null,
          },
        });
      }
    });

    const client = new CodexAppServerClient("/codex", { spawner: () => proc as any, requestTimeoutMs: 500 });
    await expect(client.listModels()).resolves.toEqual([
      { id: "gpt-5-codex", displayName: "GPT-5 Codex" },
      { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
    ]);
  });

  test("starts thread and first turn on the same process with textElements", async () => {
    let proc!: MockProcess;
    let registeredThread: string | null = null;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/unsubscribe") {
        return proc.send({ id: message.id, result: { status: "unsubscribed" } });
      }
      if (message.method === "thread/start") {
        expect(message.params).toEqual({
          projectId: "p1",
          cwd: "/repo",
          model: "gpt-5.3-codex",
        });
        return proc.send({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-5.3-codex" } });
      }
      if (message.method === "turn/start") {
        expect(registeredThread).toBe("thread-1");
        expect(message.params).toEqual({
          threadId: "thread-1",
          input: [{ type: "text", text: "[Telegram init]\nreview this", textElements: [] }],
        });
        proc.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        proc.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      }
    });

    const client = new CodexAppServerClient("/codex", { spawner: () => proc as any, requestTimeoutMs: 500 });
    await expect(client.startThreadAndTurn({
      projectId: "p1",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      prompt: "review this",
      onThreadStarted: (threadId) => {
        registeredThread = threadId;
      },
    })).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      projectId: "p1",
      cwd: "/repo",
      model: "gpt-5.3-codex",
    });

    expect(proc.writes.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
  });

  test("handles app-server approval requests while the first turn is running", async () => {
    let approvalResponseSeen = false;
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/unsubscribe") {
        return proc.send({ id: message.id, result: { status: "unsubscribed" } });
      }
      if (message.method === "thread/start") {
        return proc.send({ id: message.id, result: { thread: { id: "thread-approve" }, model: "gpt-5-codex" } });
      }
      if (message.method === "turn/start") {
        proc.send({ id: message.id, result: { turn: { id: "turn-approve" } } });
        proc.send({
          id: 77,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-approve",
            turnId: "turn-approve",
            itemId: "call-1",
            command: "git status",
            cwd: "/repo",
          },
        });
        return;
      }
      if (message.id === 77 && message.result) {
        approvalResponseSeen = true;
        expect(message).toEqual({
          id: 77,
          result: { decision: "accept" },
        });
        proc.send({
          method: "turn/completed",
          params: { threadId: "thread-approve", turn: { id: "turn-approve", status: "completed" } },
        });
      }
    });

    const client = new CodexAppServerClient("/codex", {
      spawner: () => proc as any,
      requestTimeoutMs: 500,
      inboundRequestHandler: async (request) => {
        expect(request.method).toBe("item/commandExecution/requestApproval");
        expect(request.params.itemId).toBe("call-1");
        return { decision: "accept" };
      },
    });

    await client.startThreadAndTurn({
      projectId: "p1",
      cwd: "/repo",
      prompt: "run status",
    });
    await Bun.sleep(5);
    expect(approvalResponseSeen).toBe(true);
  });

  test("treats method+id as an inbound request even when its numeric id collides with an outbound request id", async () => {
    let proc!: MockProcess;
    let approvalResponded = false;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/unsubscribe") {
        return proc.send({ id: message.id, result: { status: "unsubscribed" } });
      }
      if (message.method === "thread/start") {
        proc.send({
          id: message.id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-collision",
            turnId: "turn-collision",
            itemId: "call-collision",
          },
        });
        queueMicrotask(() => proc.send({
          id: message.id,
          result: { thread: { id: "thread-collision" }, model: "gpt-5-codex" },
        }));
        return;
      }
      if (message.result && typeof message.result === "object" && "decision" in message.result) {
        approvalResponded = true;
        return;
      }
      if (message.method === "turn/start") {
        proc.send({ id: message.id, result: { turn: { id: "turn-collision" } } });
        proc.send({
          method: "turn/completed",
          params: { threadId: "thread-collision", turn: { id: "turn-collision", status: "completed" } },
        });
      }
    });

    const client = new CodexAppServerClient("/codex", {
      spawner: () => proc as any,
      requestTimeoutMs: 500,
      inboundRequestHandler: async () => ({ decision: "accept" }),
    });

    await expect(client.startThreadAndTurn({
      projectId: "p1",
      cwd: "/repo",
      prompt: "collision",
    })).resolves.toMatchObject({ threadId: "thread-collision", turnId: "turn-collision" });
    await Bun.sleep(5);
    expect(approvalResponded).toBe(true);
  });

  test("responds to server requests with string request ids", async () => {
    let proc!: MockProcess;
    let stringIdResponseSeen = false;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/unsubscribe") {
        return proc.send({ id: message.id, result: { status: "unsubscribed" } });
      }
      if (message.method === "thread/start") {
        return proc.send({ id: message.id, result: { thread: { id: "thread-string" } } });
      }
      if (message.method === "turn/start") {
        proc.send({ id: message.id, result: { turn: { id: "turn-string" } } });
        proc.send({
          id: "approval-1",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "thread-string",
            turnId: "turn-string",
            itemId: "patch-1",
          },
        });
        return;
      }
      if (message.id === "approval-1" && message.result) {
        stringIdResponseSeen = true;
        proc.send({
          method: "turn/completed",
          params: { threadId: "thread-string", turn: { id: "turn-string", status: "completed" } },
        });
      }
    });

    const client = new CodexAppServerClient("/codex", {
      spawner: () => proc as any,
      requestTimeoutMs: 500,
      inboundRequestHandler: async () => ({ decision: "decline" }),
    });

    await client.startThreadAndTurn({
      projectId: "p1",
      cwd: "/repo",
      prompt: "string request id",
    });
    await Bun.sleep(5);
    expect(stringIdResponseSeen).toBe(true);
  });

  test("keeps an active turn session alive without an arbitrary lifetime timeout", async () => {
    let proc!: MockProcess;
    proc = new MockProcess((message) => {
      if (message.method === "initialize") return proc.send({ id: message.id, result: {} });
      if (message.method === "thread/unsubscribe") {
        return proc.send({ id: message.id, result: { status: "unsubscribed" } });
      }
      if (message.method === "thread/start") {
        return proc.send({ id: message.id, result: { thread: { id: "thread-long" } } });
      }
      if (message.method === "turn/start") {
        return proc.send({ id: message.id, result: { turn: { id: "turn-long" } } });
      }
    });

    const client = new CodexAppServerClient("/codex", {
      spawner: () => proc as any,
      requestTimeoutMs: 500,
      turnLifetimeTimeoutMs: null,
    });

    await client.startThreadAndTurn({
      projectId: "p1",
      cwd: "/repo",
      prompt: "long running task",
    });
    await Bun.sleep(10);

    expect(proc.stdinEnded).toBe(false);
    expect(proc.killed).toBe(false);

    await client.close();
    expect(proc.stdinEnded).toBe(true);
  });
});

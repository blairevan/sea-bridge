import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshReadOnlyCapability, dshReadOnlyCapabilityBaseline } from "../src/dsh/capabilities.ts";
import type { DshProject, DshSessionSummary } from "../src/dsh/types.ts";
import { DshWebHostClient } from "../src/dsh/web-host-client.ts";

interface Fixture {
  protocol: number;
  examples: Record<string, {
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  }>;
}

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/dsh-web/read-contract.json", import.meta.url), "utf8"),
) as Fixture;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

async function startConnector(
  respond: (request: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<{
  client: DshWebHostClient;
  tokenPath: string;
  socketPath: string;
  setAcceptedToken(token: string): void;
}> {
  const home = await mkdtemp(join(tmpdir(), "dsh-web-client-"));
  const runDir = join(home, "run");
  const socketPath = join(runDir, "sea-bridge.sock");
  const tokenPath = join(runDir, "sea-bridge.token");
  let acceptedToken = "a".repeat(64);
  await mkdir(runDir, { mode: 0o700 });
  await writeFile(tokenPath, acceptedToken, { mode: 0o600 });

  const server: Server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      const response = request.token === acceptedToken ? respond(request) : { ok: false, error: "unauthorized" };
      if (response) socket.end(JSON.stringify(response) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  return {
    client: new DshWebHostClient({ socketPath, tokenPath, timeoutMs: 300 }),
    tokenPath,
    socketPath,
    setAcceptedToken(token: string) {
      acceptedToken = token;
    },
  };
}

function fixtureResponder(request: Record<string, unknown>): Record<string, unknown> {
  const op = String(request.op);
  const example = fixture.examples[op];
  if (!example) return { ok: false, error: "unsupported" };
  return example.response;
}

describe("DshWebHostClient", () => {
  test("accepts a bounded live event window and rejects a noncontiguous event", async () => {
    const { client } = await startConnector(() => ({ ok: true, observed: true, cursor: 4,
      event: { type: "turn/end", seq: 5, time: 55, reasonKind: "completed", data: "private" },
    }));
    expect(await client.followWindow("session-example")).toEqual({ observed: true, cursor: 4,
      event: { type: "turn/end", seq: 5, time: 55, reasonKind: "completed" } });
    const invalid = await startConnector(() => ({ ok: true, observed: true, cursor: 4,
      event: { type: "turn/end", seq: 6, time: 55, reasonKind: "completed" },
    }));
    await expect(invalid.client.followWindow("session-example")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test("refuses to silently baseline only a truncated session listing", async () => {
    const { client } = await startConnector(() => ({ ok: true, totalCount: 201, items: [
      { sessionId: "one", updatedAt: 1, running: false, blank: false },
    ] }));
    await expect(client.listSessions()).rejects.toMatchObject({ code: "contract_unsupported" });
  });

  test("rejects incomplete project and model catalogs instead of silently truncating", async () => {
    const projects = await startConnector(() => ({
      ok: true,
      totalCount: 2,
      items: [{ id: "p1", title: "One", sessionCount: 1 }],
    }));
    await expect(projects.client.listProjects()).rejects.toMatchObject({ code: "contract_unsupported" });

    const groups = await startConnector(() => ({
      ok: true,
      default: { provider: "p", model: "m" },
      groupCount: 2,
      groups: [{ id: "p", name: "Provider", modelCount: 1, models: [{ id: "m", name: "Model" }] }],
      failureCount: 0,
    }));
    await expect(groups.client.listModels()).rejects.toMatchObject({ code: "contract_unsupported" });

    const models = await startConnector(() => ({
      ok: true,
      default: { provider: "p", model: "m" },
      groupCount: 1,
      groups: [{ id: "p", name: "Provider", modelCount: 2, models: [{ id: "m", name: "Model" }] }],
      failureCount: 0,
    }));
    await expect(models.client.listModels()).rejects.toMatchObject({ code: "contract_unsupported" });
  });

  test("accepts only a fixed turn reason category and never exposes extra fields", async () => {
    const { client } = await startConnector(() => ({ ok: true, hasMore: false, truncated: false,
      events: [{ type: "turn/end", seq: 3, time: 55, reasonKind: "completed", private: "secret" }],
    }));
    expect(await client.pageHistory("session-example", 3)).toEqual({
      hasMore: false, truncated: false,
      events: [{ type: "turn/end", seq: 3, time: 55, reasonKind: "completed" }],
    });
  });

  test("implements only the Task 0A-proven metadata reads", async () => {
    const { client } = await startConnector(fixtureResponder);

    expect(await client.health()).toEqual({
      status: "mounted",
      protocol: fixture.protocol,
      connectorVersion: "0.2.0",
    });
    expect(await client.listProjects()).toEqual(fixture.examples["projects.list"]!.response.items as DshProject[]);
    expect(await client.listSessions()).toEqual(fixture.examples["sessions.list"]!.response.items as DshSessionSummary[]);
    expect(await client.followSnapshot("session-example")).toEqual({
      cursor: 2,
      hasMore: false,
      truncated: false,
      events: [{ type: "assistant/message", seq: 2, time: 42 }],
    });
    expect(await client.pageHistory("session-example", 2)).toEqual({
      hasMore: false,
      truncated: false,
      events: [{ type: "assistant/message", seq: 2, time: 42 }],
    });
    expect(await client.listModels()).toEqual({
      default: { provider: "provider-example", model: "model-example" },
      groups: [{
        id: "provider-example",
        name: "Example",
        models: [{ id: "model-example", name: "Example Model" }],
      }],
      failureCount: 0,
    });

    expect("submitPrompt" in client).toBe(false);
    expect("createSession" in client).toBe(false);
    expect("readEvents" in client).toBe(false);
  });

  test("marks observation partial until production end-to-end verification", () => {
    expect(dshReadOnlyCapability("transport").status).toBe("available");
    expect(dshReadOnlyCapability("observation")).toEqual({
      name: "observation",
      status: "partial",
      reason: "bounded_live_follow_and_recovery_verified; production_end_to_end_unverified",
    });
    expect(dshReadOnlyCapability("projects").status).toBe("available");
    expect(dshReadOnlyCapability("models").status).toBe("available");
    expect(dshReadOnlyCapability("reply").status).toBe("unavailable");
    expect(dshReadOnlyCapability("creation").status).toBe("unavailable");
    expect(dshReadOnlyCapabilityBaseline()).toHaveLength(6);
  });

  test("reloads the token for each request so connector remounts do not require a client restart", async () => {
    const connector = await startConnector(fixtureResponder);

    expect(await connector.client.health()).toEqual({
      status: "mounted",
      protocol: 1,
      connectorVersion: "0.2.0",
    });
    const nextToken = "b".repeat(64);
    connector.setAcceptedToken(nextToken);
    await writeFile(connector.tokenPath, nextToken, { mode: 0o600 });
    expect(await connector.client.health()).toEqual({
      status: "mounted",
      protocol: 1,
      connectorVersion: "0.2.0",
    });
  });

  test("rejects broad token permissions before opening the connector", async () => {
    const { client, tokenPath } = await startConnector(fixtureResponder);
    await chmod(tokenPath, 0o644);

    await expect(client.health()).rejects.toMatchObject({
      code: "unsafe_runtime_path",
    });
  });

  test("maps connector and transport failures without exposing auth material", async () => {
    const unauthorized = await startConnector(() => ({ ok: false, error: "unauthorized" }));
    await expect(unauthorized.client.health()).rejects.toMatchObject({
      code: "unauthorized",
    });

    const unsupported = await startConnector(() => ({ ok: false, error: "unsupported" }));
    await expect(unsupported.client.listProjects()).rejects.toMatchObject({
      code: "contract_unsupported",
    });

    const invalid = await startConnector(() => ({
      ok: true,
      status: "mounted",
      protocol: 2,
      connectorVersion: "0.2.0",
    }));
    await expect(invalid.client.health()).rejects.toMatchObject({
      code: "contract_unsupported",
    });
  });

  test("cancels an in-flight connector request for bounded observer shutdown", async () => {
    const hanging = await startConnector(() => null);
    const controller = new AbortController();
    const request = hanging.client.listSessions(controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "cancelled" });
  });

  test("uses a bounded request timeout and validates session/history arguments locally", async () => {
    const hanging = await startConnector(() => null);
    await expect(hanging.client.health()).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(hanging.client.followSnapshot("../bad")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(hanging.client.pageHistory("session-example", -2)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

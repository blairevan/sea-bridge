import { describe, expect, test } from "bun:test";
import { loadWebConfig } from "../src/config.ts";
import { startWebLifecycle } from "../src/web/server.ts";
import type { Logger } from "../src/logger.ts";
import { WebRuntime } from "../src/web/runtime.ts";
import { StateDb } from "../src/state/db.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("full runtime recovers before requests and cleans socket/server before database close", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-runtime-")); const state = new StateDb(":memory:"); migrateWeb(state.db);
  const store = new WebStore(state.db);
  store.claimOperation({ id: "incomplete", digest: "fixture", kind: "send", source: "codex", deviceId: "fixture", targetId: "thread", projectId: null, modelId: null, createdAt: Date.now() });
  store.transitionOperation("incomplete", "received", "dispatching", Date.now());
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port; await probe.stop(true); if (!port) throw new Error("no port");
  const config = loadWebConfig({ SEA_BRIDGE_WEB_ENABLED: "true", SEA_BRIDGE_WEB_PORT: String(port), SEA_BRIDGE_WEB_CONTROL_SOCKET: join(root, "control.sock"), SEA_BRIDGE_WEB_OPERATION_PEPPER_PATH: join(root, "key") });
  // Existing operations require the original key, even if their payload is only a fixture.
  const { loadOperationPepper } = await import("../src/web/crypto.ts"); loadOperationPepper(config.operationPepperPath, false);
  const runtime = new WebRuntime({ config, db: state.db, secrets: [], sourceFactory: () => ({}), telegramStatus: () => ({ stopped: true, lastPollSuccessAt: null, pollFailed: false }), staticRoot: "src/web/public" });
  try {
    await runtime.start();
    expect(store.getOperation("incomplete")?.state).toBe("delivery_unknown");
    expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(401);
    expect(existsSync(config.controlSocketPath)).toBe(true);
  } finally { await runtime.stop(); state.close(); rmSync(root, { recursive: true, force: true }); }
  expect(existsSync(config.controlSocketPath)).toBe(false);
});

describe("Web configuration", () => {
  test("defaults off with fixed loopback and home paths", () => {
    const config = loadWebConfig({});
    expect(config.enabled).toBe(false);
    expect(config.port).toBe(7310);
    expect(config.remoteOrigin).toBeNull();
    expect(config.controlSocketPath.startsWith("/")).toBe(true);
    expect(config.operationPepperPath.startsWith("/")).toBe(true);
  });

  test("validates exact HTTPS origin and strict port syntax", () => {
    expect(loadWebConfig({ SEA_BRIDGE_WEB_PORT: "7311", SEA_BRIDGE_WEB_REMOTE_ORIGIN: "https://example.test:8443" }).port).toBe(7311);
    for (const port of ["0", "65536", "12abc", "1.5", "-1"]) {
      expect(() => loadWebConfig({ SEA_BRIDGE_WEB_PORT: port })).toThrow();
    }
    for (const origin of ["http://example.test", "https://example.test/", "https://example.test/a", "https://example.test?q=1", "https://user@example.test", "https://example.test#x"]) {
      expect(() => loadWebConfig({ SEA_BRIDGE_WEB_REMOTE_ORIGIN: origin })).toThrow();
    }
    expect(() => loadWebConfig({ SEA_BRIDGE_WEB_ENABLED: "maybe" })).toThrow();
  });
});

describe("fail-soft Web lifecycle", () => {
  test("disabled mode constructs no service", async () => {
    let calls = 0;
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    expect(await startWebLifecycle(() => loadWebConfig({}), () => { calls++; throw new Error("unused"); }, logger)).toBeNull();
    expect(calls).toBe(0);
  });

  test("invalid config and partial start are contained and cleaned", async () => {
    const warnings: string[] = [];
    let stopped = 0;
    const logger: Logger = { debug() {}, info() {}, warn(event) { warnings.push(event); }, error() {} };
    expect(await startWebLifecycle(() => { throw new Error("sensitive config"); }, () => { throw new Error("unused"); }, logger)).toBeNull();
    expect(await startWebLifecycle(() => loadWebConfig({ SEA_BRIDGE_WEB_ENABLED: "true" }), () => ({
      async start() { throw new Error("port conflict"); },
      async stop() { stopped++; },
    }), logger)).toBeNull();
    expect(stopped).toBe(1);
    expect(warnings).toEqual(["web_start_failed", "web_start_failed"]);
  });

  test("successful startup returns an idempotent stop wrapper", async () => {
    let stops = 0;
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const service = await startWebLifecycle(() => loadWebConfig({ SEA_BRIDGE_WEB_ENABLED: "true" }), () => ({
      async start() {}, async stop() { stops++; },
    }), logger);
    await Promise.all([service?.stop(), service?.stop()]);
    expect(stops).toBe(1);
  });
});

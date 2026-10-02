import { describe, expect, test } from "bun:test";
import { loadWebConfig } from "../src/config.ts";
import { startWebLifecycle } from "../src/web/server.ts";
import type { Logger } from "../src/logger.ts";

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

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { WebRuntime } from "../src/web/runtime.ts";
import { loadWebConfig } from "../src/config.ts";
import { LOGIN_FIXTURE, LOGIN_HASH } from "./helpers/web-login.ts";

/** Provision a synthetic administrator using the running private control socket. */
function provision(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); let response = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("fixture timeout")));
    socket.on("connect", () => socket.end(JSON.stringify({ op: "account.set", username: LOGIN_FIXTURE.username, passwordHash: LOGIN_HASH })));
    socket.on("data", (data) => { response += data.toString(); });
    socket.on("end", () => resolve(response)); socket.on("error", reject);
  });
}

test("real HTTP runtime provisions, logs in, logs out, resets and rejects the old pairing API", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-password-runtime-")); const db = new Database(":memory:");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port; await probe.stop(true);
  if (!port) throw new Error("fixture port unavailable");
  const config = loadWebConfig({ SEA_BRIDGE_WEB_ENABLED: "true", SEA_BRIDGE_WEB_PORT: String(port), SEA_BRIDGE_WEB_CONTROL_SOCKET: join(root, "control.sock"), SEA_BRIDGE_WEB_OPERATION_PEPPER_PATH: join(root, "pepper") });
  const runtime = new WebRuntime({ config, db, secrets: [], sourceFactory: () => ({}), telegramStatus: () => ({ stopped: true, lastPollSuccessAt: null, pollFailed: false }), staticRoot: "src/web/public" });
  const origin = `http://127.0.0.1:${port}`;
  /** Send a real browser-style request to the isolated loopback listener. */
  const request = (path: string, method = "GET", body?: unknown, cookie?: string, csrf?: string) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-Sea-Bridge-CSRF": csrf } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await runtime.start();
    const shell = await (await request("/")).text(); expect(shell).toContain('autocomplete="current-password"'); expect(shell).not.toContain("配对码");
    expect((await request("/api/auth/pair", "POST", { code: "12345678" })).status).toBe(404);
    expect((await request("/api/auth/login", "POST", LOGIN_FIXTURE)).status).toBe(401);
    expect(JSON.parse(await provision(config.controlSocketPath)).updated).toBe(true);
    expect((await request("/api/auth/login", "POST", { ...LOGIN_FIXTURE, password: "wrong" })).status).toBe(401);
    const loggedIn = await request("/api/auth/login", "POST", LOGIN_FIXTURE); expect(loggedIn.status).toBe(200);
    const cookies = loggedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const csrf = /sea_csrf=([^;]+)/.exec(cookies)?.[1]; if (!csrf) throw new Error("fixture csrf unavailable");
    expect((await request("/api/auth/session", "GET", undefined, cookies)).status).toBe(200);
    expect((await request("/api/auth/logout", "POST", undefined, cookies)).status).toBe(403);
    expect((await request("/api/auth/logout", "POST", undefined, cookies, csrf)).status).toBe(200);
    expect((await request("/api/auth/session", "GET", undefined, cookies)).status).toBe(401);
    const relogin = await request("/api/auth/login", "POST", LOGIN_FIXTURE); expect(relogin.status).toBe(200);
    const oldCookies = relogin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    await provision(config.controlSocketPath);
    expect((await request("/api/auth/session", "GET", undefined, oldCookies)).status).toBe(401);
  } finally { await runtime.stop(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

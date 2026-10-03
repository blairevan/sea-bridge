import { APP_VERSION, renderVersionedShell } from "../src/web/version.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebServer } from "../src/web/server.ts";
import { loadWebConfig } from "../src/config.ts";

test("static shell has local assets and no unsafe rendering or persistent body cache", async () => {
  const html = renderVersionedShell(await Bun.file("src/web/public/index.html").text());
  const script = await Bun.file("src/web/public/app.js").text();
  const css = await Bun.file("src/web/public/app.css").text();
  expect(html).toContain(`src="/app.js?v=${APP_VERSION}"`); expect(html).toContain(`href="/app.css?v=${APP_VERSION}"`);
  expect(html).not.toContain('id="connection-panel"'); expect(html).not.toContain('id="connection-retry"');
  expect(script).not.toContain("connection-panel"); expect(css).not.toContain(".connection-panel");
  expect(html).toContain('id="notice-bar"'); expect(html).toContain('id="notice-toggle"'); expect(html).toContain('id="notice-retry"'); expect(html).toContain('id="notice-close"');
  for (const id of ["overview-total", "overview-running", "overview-approval", "overview-new-session", "overview-privacy", "activity-filter", "catalog-dialog", "catalog-items", "catalog-new", "catalog-retry", "close-catalog"]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain('role="combobox"'); expect(html).toContain('aria-controls="record-suggestions"'); expect(html).toContain('会话标题'); expect(html).not.toContain('<label>会话 ID');
  expect(html).toContain('<label'); expect(html).not.toMatch(/https?:\/\//);
  expect(script).not.toMatch(/innerHTML|indexedDB|serviceWorker/);
  const pointerStart = script.indexOf("function lastSessionPointer()");
  const pointerEnd = script.indexOf("/** Select the previous conversation", pointerStart);
  expect(script.slice(0, pointerStart) + script.slice(pointerEnd)).not.toContain("localStorage");
  expect(script).toContain("textContent"); expect(script).toContain("crypto.randomUUID");
  expect(script).toContain('run("reconnect-" + streamSeq, () => finishRecovery(stream))');
  expect(script).toContain('const session = await requestApi("/api/auth/session")');
  expect(script).toContain('const settings = await requestApi("/api/settings")');
  expect(script).toContain("stream.readyState !== EventSource.OPEN");
  expect(script).toContain('new Set(["invalid_field", "invalid_source", "invalid_operation_id", "body_too_large", "source_unavailable", "csrf_denied", "operation_conflict"])');
  expect(css).toContain("#console{height:100dvh;display:flex;flex-direction:column;overflow:hidden}");
  expect(css).toContain(".workspace{display:flex;flex:1;min-height:0;overflow:hidden}");
  expect(css).toContain(".notice-text{flex:1;min-width:0;line-height:1.55");
  expect(css).toContain("-webkit-line-clamp:2");
  expect(css).toContain(".notice-bar.expanded .notice-text");
  expect(css).toContain(".notice-bar.notice-connection");
  expect(css).toContain("#sessions{padding:0;display:flex;height:100%;min-height:0;overflow:hidden}");
  expect(css).toContain("#messages{flex:1;min-height:0;overflow:auto");
});

test("HTTP shutdown drains an admitted handler before its shared resources close", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port; await probe.stop(true); if (!port) throw new Error("fixture port missing");
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let persisted = false;
  const server = new WebServer({ config: loadWebConfig({ SEA_BRIDGE_WEB_PORT: String(port) }), staticRoot: "src/web/public", handler: async () => {
    enter(); await held; persisted = true; return new Response("done");
  } });
  try {
    await server.start(); const client = fetch(`http://127.0.0.1:${port}/api/fixture`).catch(() => null);
    await entered; let stopped = false;
    const stopping = server.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve)); expect(stopped).toBe(false);
    release(); await stopping; await client; expect(persisted).toBe(true);
  } finally { release(); await server.stop(); }
});

test("real loopback server sends strict static headers, allows no traversal, and fails for missing assets", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port; await probe.stop(true); if (!port) throw new Error("no fixture port");
  const server = new WebServer({ config: loadWebConfig({ SEA_BRIDGE_WEB_PORT: String(port) }), staticRoot: "src/web/public", handler: async () => new Response("not found", { status: 404 }) });
  try {
    await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toContain(`v${APP_VERSION}`);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await fetch(`http://127.0.0.1:${port}/config.ts`)).status).toBe(404);
  } finally { await server.stop(); }
  const root = mkdtempSync(join(tmpdir(), "web-missing-assets-"));
  try { await expect(new WebServer({ config: loadWebConfig({}), staticRoot: root, handler: async () => new Response() }).start()).rejects.toThrow("web_asset_missing"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

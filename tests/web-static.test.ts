import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebServer } from "../src/web/server.ts";
import { loadWebConfig } from "../src/config.ts";

test("static shell has local assets and no unsafe rendering or persistent body cache", async () => {
  const html = await Bun.file("src/web/public/index.html").text();
  const script = await Bun.file("src/web/public/app.js").text();
  expect(html).toContain('src="/app.js"'); expect(html).toContain('href="/app.css"');
  expect(html).toContain('<label'); expect(html).not.toMatch(/https?:\/\//);
  expect(script).not.toMatch(/innerHTML|localStorage|indexedDB|serviceWorker/);
  expect(script).toContain("textContent"); expect(script).toContain("crypto.randomUUID");
});

test("real loopback server sends strict static headers, allows no traversal, and fails for missing assets", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port; await probe.stop(true); if (!port) throw new Error("no fixture port");
  const server = new WebServer({ config: loadWebConfig({ SEA_BRIDGE_WEB_PORT: String(port) }), staticRoot: "src/web/public", handler: async () => new Response("not found", { status: 404 }) });
  try {
    await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await fetch(`http://127.0.0.1:${port}/config.ts`)).status).toBe(404);
  } finally { await server.stop(); }
  const root = mkdtempSync(join(tmpdir(), "web-missing-assets-"));
  try { await expect(new WebServer({ config: loadWebConfig({}), staticRoot: root, handler: async () => new Response() }).start()).rejects.toThrow("web_asset_missing"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

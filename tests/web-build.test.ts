import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WebServer as ServerType } from "../src/web/server.ts";
import { APP_VERSION } from "../src/web/version.ts";

test("built Web component serves packaged assets without any source-root lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-build-"));
  try {
    const child = Bun.spawn(["bun", "run", "scripts/build.ts", root], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    for (const file of ["main.js", "server.js", "web/index.html", "web/app.js", "web/app.css", "web/favicon.svg", "web/apple-touch-icon.png"]) expect(await Bun.file(join(root, file)).exists()).toBe(true);
    const module = await import(pathToFileURL(join(root, "server.js")).href) as { WebServer: typeof ServerType; resolveWebStaticRoot: () => Promise<string> };
    expect(await module.resolveWebStaticRoot()).toBe(realpathSync(join(root, "web")));
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port; await probe.stop(true); if (!port) throw new Error("no port");
    const server = new module.WebServer({ config: { enabled: true, port, remoteOrigin: null, controlSocketPath: join(root, "control"), operationPepperPath: join(root, "pepper") }, staticRoot: join(root, "web"), handler: async () => Response.json({ fixture: true }) });
    try {
      await server.start();
      for (const route of ["/", "/app.js", "/app.css", "/api/fixture"]) expect((await fetch(`http://127.0.0.1:${port}${route}`)).status).toBe(200);
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(html).toContain('rel="icon" type="image/svg+xml"');
      expect(html).toContain('rel="apple-touch-icon" sizes="180x180"');
      expect(html).toContain(`href="/favicon.svg?v=${APP_VERSION}"`);
      expect(html).toContain(`href="/apple-touch-icon.png?v=${APP_VERSION}"`);
      for (const [route, type] of [["/favicon.svg", "image/svg+xml"], ["/apple-touch-icon.png", "image/png"]] as const) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe(type);
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const versioned = await fetch(`http://127.0.0.1:${port}${route}?v=${APP_VERSION}`);
        expect(versioned.status).toBe(200);
        expect(versioned.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
        const obsolete = await fetch(`http://127.0.0.1:${port}${route}?v=0.0.0`);
        expect(obsolete.headers.get("Cache-Control")).toBe("no-store");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (type === "image/png") {
          expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
          const dimensions = new DataView(bytes.buffer);
          expect(dimensions.getUint32(16)).toBe(180);
          expect(dimensions.getUint32(20)).toBe(180);
        } else expect(new TextDecoder().decode(bytes)).toContain('viewBox="0 0 64 64"');
      }
    } finally { await server.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

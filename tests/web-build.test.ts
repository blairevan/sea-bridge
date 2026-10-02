import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WebServer as ServerType } from "../src/web/server.ts";

test("built Web component serves packaged assets without any source-root lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-build-"));
  try {
    const child = Bun.spawn(["bun", "run", "scripts/build.ts", root], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    for (const file of ["main.js", "server.js", "web/index.html", "web/app.js", "web/app.css"]) expect(await Bun.file(join(root, file)).exists()).toBe(true);
    const module = await import(pathToFileURL(join(root, "server.js")).href) as { WebServer: typeof ServerType; resolveWebStaticRoot: () => Promise<string> };
    expect(await module.resolveWebStaticRoot()).toBe(realpathSync(join(root, "web")));
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port; await probe.stop(true); if (!port) throw new Error("no port");
    const server = new module.WebServer({ config: { enabled: true, port, remoteOrigin: null, controlSocketPath: join(root, "control"), operationPepperPath: join(root, "pepper") }, staticRoot: join(root, "web"), handler: async () => Response.json({ fixture: true }) });
    try {
      await server.start();
      for (const route of ["/", "/app.js", "/app.css", "/api/fixture"]) expect((await fetch(`http://127.0.0.1:${port}${route}`)).status).toBe(200);
    } finally { await server.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

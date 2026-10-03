import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebControlServer } from "../src/web/control-server.ts";

/** Send a single local control request and collect its bounded response. */
function request(path: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); let response = "";
    socket.setTimeout(1000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.end(text));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("end", () => resolve(response)); socket.on("error", reject);
  });
}

test("control shutdown closes an unfinished client without waiting for idle timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-control-stop-"));
  const db = new Database(":memory:"); migrateWeb(db);
  const path = join(root, "control.sock"); const server = new WebControlServer(path, new WebAuth(new WebStore(db)));
  try {
    await server.start();
    const client = connect(path); client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", resolve)); client.write(" ");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([server.stop().then(() => true), new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 200); })]);
      expect(stopped).toBe(true);
    } finally { if (timeout) clearTimeout(timeout); client.destroy(); }
  } finally { await server.stop(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("private control socket allows only bounded pair.create and rejects live collisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-control-"));
  const db = new Database(":memory:"); migrateWeb(db);
  const path = join(root, "private", "control.sock");
  const auth = new WebAuth(new WebStore(db)); const server = new WebControlServer(path, auth);
  try {
    await server.start();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
    const result = JSON.parse(await request(path, '{"op":"pair.create"}\n')) as { code: string };
    expect(result.code).toMatch(/^\d{8}$/);
    expect(await request(path, '{"op":"unknown"}\n')).not.toContain("code");
    expect(await request(path, '{"op":"pair.create"}\n{"op":"pair.create"}\n')).not.toContain("code");
    expect(await request(path, "x".repeat(2048))).not.toContain("code");
    await expect(new WebControlServer(path, auth).start()).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
  } finally { await server.stop(); db.close(); rmSync(root, { recursive: true, force: true }); }
  expect(existsSync(path)).toBe(false);
});


test("control startup rejects ordinary files and safely recovers a private stale socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-control-stale-"));
  const db = new Database(":memory:"); migrateWeb(db);
  const auth = new WebAuth(new WebStore(db));
  const path = join(root, "control.sock");
  const server = new WebControlServer(path, auth);
  try {
    const ordinary = join(root, "ordinary"); writeFileSync(ordinary, "keep", { mode: 0o600 });
    await expect(new WebControlServer(ordinary, auth).start()).rejects.toThrow("web_control_path_unsafe");
    symlinkSync(ordinary, join(root, "link"));
    await expect(new WebControlServer(join(root, "link"), auth).start()).rejects.toThrow("web_control_path_unsafe");
    const child = Bun.spawnSync(["python3", "-c", "import socket,os,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chmod(sys.argv[1],0o600)", path]);
    expect(child.exitCode).toBe(0);
    await server.start();
    expect(JSON.parse(await request(path, '{"op":"pair.create"}\n')).code).toMatch(/^\d{8}$/);
  } finally { await server.stop(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

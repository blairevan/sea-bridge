import { createServer, connect, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { WebAuth } from "./auth.ts";

/** Local-only administrator provisioning with ownership-aware socket cleanup. */
export class WebControlServer {
  private server: Server | null = null;
  private inode: number | null = null;
  private readonly sockets = new Set<Socket>();

  /** The socket path is operator configuration, never browser input. */
  constructor(private readonly path: string, private readonly auth: WebAuth, private readonly accountChanged: () => void = () => {}) {}

  /** Bind a private socket, removing only a proven stale owner-private socket. */
  async start(): Promise<void> {
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("web_control_parent_not_private");
    }
    await this.removeStaleSocket();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      this.sockets.add(socket);
      const deadline = setTimeout(() => socket.destroy(), 2000);
      deadline.unref();
      socket.once("close", () => { clearTimeout(deadline); this.sockets.delete(socket); });
      let text = ""; let complete = false;
      socket.setTimeout(2000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("data", (chunk: Buffer) => {
        if (complete) return;
        text += chunk.toString("utf8");
        if (Buffer.byteLength(text) > 1024) { complete = true; socket.end('{"error":"invalid_request"}\n'); }
      });
      socket.on("end", () => {
        if (complete) return; complete = true;
        try {
          const parsed: unknown = JSON.parse(text.trim());
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
              Object.keys(parsed).sort().join(",") !== "op,passwordHash,username") {
            socket.end('{"error":"invalid_request"}\n'); return;
          }
          const row = parsed as Record<string, unknown>;
          if (row.op !== "account.set" || typeof row.username !== "string" || typeof row.passwordHash !== "string") {
            socket.end('{"error":"invalid_request"}\n'); return;
          }
          this.auth.setAccount(row.username, row.passwordHash);
          this.accountChanged();
          socket.end('{"updated":true}\n');
        } catch { socket.end('{"error":"invalid_request"}\n'); }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.path, resolve); });
    chmodSync(this.path, 0o600);
    this.inode = lstatSync(this.path).ino;
  }

  /** Close the owned server and unlink only the socket inode that it created. */
  async stop(): Promise<void> {
    const server = this.server; this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (this.inode !== null && lstatSync(this.path).ino === this.inode) unlinkSync(this.path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.inode = null;
  }

  /** Probe without commands; ambiguity or a live listener always preserves the socket. */
  private async removeStaleSocket(): Promise<void> {
    let stat;
    try { stat = lstatSync(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("web_control_path_unsafe");
    await new Promise<void>((resolve, reject) => {
      const probe = connect(this.path);
      probe.setTimeout(500, () => { probe.destroy(); reject(new Error("web_control_probe_unknown")); });
      probe.once("connect", () => { probe.destroy(); reject(new Error("web_control_already_running")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve(); else reject(new Error("web_control_probe_failed"));
      });
    });
    if (lstatSync(this.path).ino !== stat.ino) throw new Error("web_control_path_changed");
    unlinkSync(this.path);
  }
}

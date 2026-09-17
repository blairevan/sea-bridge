import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../../logger.ts";
import type { HookTransportRequest, HookTransportResponse } from "../hook-types.ts";
import type { CodexHookProvider, HookHandleResult } from "./codex-hook.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

export class HookServer {
  private server: Server | null = null;
  private lockFd: number | null = null;
  private readonly lockPath: string;

  private initializeLockPath(): string {
    return `${this.socketPath}.lock`;
  }

  constructor(
    private readonly socketPath: string,
    private readonly provider: CodexHookProvider,
    private readonly logger: Logger,
  ) {
    this.lockPath = this.initializeLockPath();
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.prepareSocketPath();
    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(this.socketPath, () => {
          server.off("error", onError);
          chmodSync(this.socketPath, 0o600);
          resolve();
        });
      });
      this.logger.info("hook_server_started", { socketPath: this.socketPath });
    } catch (error) {
      this.server = null;
      try { server.close(); } catch {}
      try { unlinkSync(this.socketPath); } catch {}
      this.releaseLock();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try { unlinkSync(this.socketPath); } catch {}
    this.releaseLock();
  }

  private prepareSocketPath(): void {
    const dir = dirname(this.socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.acquireLock();

    try {
      const stat = lstatSync(this.socketPath);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink hook socket path: ${this.socketPath}`);
      if (!stat.isSocket()) throw new Error(`Refusing non-socket hook path: ${this.socketPath}`);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error(`Refusing hook socket owned by uid ${stat.uid}`);
      }
      unlinkSync(this.socketPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.releaseLock();
        throw error;
      }
    }
  }

  private acquireLock(): void {
    try {
      this.lockFd = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(this.lockFd, `${process.pid}\n`, "utf8");
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const lockStat = lstatSync(this.lockPath);
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error(`Refusing unsafe lock path: ${this.lockPath}`);
    if (typeof process.getuid === "function" && lockStat.uid !== process.getuid()) {
      throw new Error(`Refusing lock owned by uid ${lockStat.uid}`);
    }

    let pid = 0;
    try { pid = Number.parseInt(readFileSync(this.lockPath, "utf8").trim(), 10); } catch {}
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
        throw new Error(`Another Sea-Bridge process is active (pid ${pid})`);
      } catch (error: any) {
        if (error?.code !== "ESRCH") throw error;
      }
    }

    unlinkSync(this.lockPath);
    this.lockFd = openSync(this.lockPath, "wx", 0o600);
    writeFileSync(this.lockFd, `${process.pid}\n`, "utf8");
  }

  private releaseLock(): void {
    if (this.lockFd != null) {
      try { closeSync(this.lockFd); } catch {}
      this.lockFd = null;
    }
    try { unlinkSync(this.lockPath); } catch {}
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;

    const fail = (reason: string) => {
      this.logger.warn("hook_transport_error", { reason });
      if (!socket.destroyed) socket.destroy();
    };

    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        fail("request_too_large");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffer.slice(0, newline);
      void this.processLine(socket, line);
    });
    socket.on("error", (error) => this.logger.warn("hook_socket_error", { error: String(error) }));
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    let request: HookTransportRequest;
    try {
      request = JSON.parse(line) as HookTransportRequest;
    } catch {
      socket.end();
      return;
    }

    let result: HookHandleResult;
    try {
      result = await this.provider.handle(request);
    } catch (error) {
      this.logger.error("hook_provider_failed", { error: String(error), invocationId: request.invocationId });
      result = { output: null };
    }

    const response: HookTransportResponse = {
      protocolVersion: 1,
      invocationId: request.invocationId,
      output: result.output,
    };
    const payload = `${JSON.stringify(response)}\n`;

    let settled = false;
    const failed = () => {
      if (settled) return;
      settled = true;
      result.onDeliveryFailed?.();
    };
    socket.once("error", failed);
    socket.write(payload, (error) => {
      if (error) {
        failed();
        socket.destroy();
        return;
      }
      if (!settled) {
        settled = true;
        result.onDelivered?.();
      }
      socket.end();
    });
  }
}

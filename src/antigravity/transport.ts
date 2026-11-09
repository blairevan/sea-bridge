import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseAcpFrame, type AcpInboundFrame, type JsonRpcId } from "./protocol.ts";

export interface AcpTransportOptions {
  cliPath: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  processGeneration: number;
  maxFrameBytes?: number | undefined;
  defaultTimeoutMs?: number | undefined;
  onNotification?: ((method: string, params: unknown) => void) | undefined;
  onRequest?: ((id: JsonRpcId, method: string, params: unknown) => Promise<unknown>) | undefined;
  onExit?: ((info: { code: number | null; signal: NodeJS.Signals | null; generation: number }) => void) | undefined;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;

/**
 * Controlled stdio NDJSON transport for `agy acp`.
 * Spawns via argv (never shell), enforces UTF-8 streaming decode, frame size caps,
 * and tracks exact child PID + processGeneration so cleanup never kills unrelated processes.
 */
export class AcpStdioTransport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRpc>();
  private closed = false;
  private pid: number | null = null;
  private startedAt: number | null = null;

  constructor(private readonly options: AcpTransportOptions) {}

  /** Spawn the `agy acp` child process and start reading NDJSON frames. */
  start(): void {
    if (this.proc) return;
    const child = spawn(this.options.cliPath, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.proc = child;
    this.pid = child.pid ?? null;
    this.startedAt = Date.now();

    const maxBytes = this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      buffer += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > maxBytes && !buffer.includes("\n")) {
        this.failAll(new Error("acp_frame_too_large"));
        this.close();
        return;
      }
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (Buffer.byteLength(rawLine, "utf8") > maxBytes) {
          this.failAll(new Error("acp_frame_too_large"));
          this.close();
          return;
        }
        const trimmed = rawLine.trim();
        if (!trimmed || !trimmed.startsWith("{")) {
          // Ignore non-JSON spinner or diagnostic noise lines
          continue;
        }
        this.handleLine(trimmed);
      }
    });

    child.on("error", (err) => {
      this.failAll(new Error(`acp_spawn_error:${err.message}`));
    });

    child.on("close", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`acp_process_exited:${code ?? signal ?? "unknown"}`));
      this.options.onExit?.({
        code,
        signal,
        generation: this.options.processGeneration,
      });
    });
  }

  /** Return process identity metadata for safe ownership checks. */
  identity(): { pid: number | null; startedAt: number | null; generation: number; closed: boolean } {
    return {
      pid: this.pid,
      startedAt: this.startedAt,
      generation: this.options.processGeneration,
      closed: this.closed,
    };
  }

  /** Send a JSON-RPC request and await its matched response. Use timeoutMs=0 for unbounded prompt turns. */
  request(method: string, params: unknown, timeoutMs = this.options.defaultTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS): { id: number; promise: Promise<unknown> } {
    if (this.closed || !this.proc) {
      return { id: -1, promise: Promise.reject(new Error("acp_transport_closed")) };
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`acp_request_timeout:${method}`));
            }, timeoutMs)
          : null;

      this.pending.set(id, { resolve, reject, timer });
      this.writeRaw(payload).catch((err) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    return { id, promise };
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed || !this.proc) {
      throw new Error("acp_transport_closed");
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    await this.writeRaw(payload);
  }

  /** Terminate only the owned child process of this transport instance. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("acp_transport_closed"));
    if (this.proc && this.proc.pid) {
      try {
        this.proc.stdin.end();
      } catch {
        // ignore stdin close errors
      }
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore kill errors if already exited
      }
    }
  }

  private writeRaw(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.closed) {
        reject(new Error("acp_transport_closed"));
        return;
      }
      let settled = false;
      const done = (err?: Error | null) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      const canContinue = this.proc.stdin.write(payload, "utf8", (err) => {
        if (err) done(err);
      });
      if (canContinue) {
        done();
      } else {
        this.proc.stdin.once("drain", () => done());
      }
    });
  }

  private handleLine(line: string): void {
    let frame: AcpInboundFrame;
    try {
      frame = parseAcpFrame(line);
    } catch {
      return;
    }

    if (frame.kind === "response") {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(frame.result);
      return;
    }

    if (frame.kind === "error") {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`acp_rpc_error:${frame.error.code}:${frame.error.message}`));
      return;
    }

    if (frame.kind === "notification") {
      this.options.onNotification?.(frame.method, frame.params);
      return;
    }

    if (frame.kind === "request") {
      void this.handleInboundRequest(frame.id, frame.method, frame.params);
    }
  }

  private async handleInboundRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.options.onRequest) {
      await this.writeRaw(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not supported: ${method}` },
        }) + "\n"
      ).catch(() => {});
      return;
    }
    try {
      const result = await this.options.onRequest(id, method, params);
      if (!this.closed) {
        await this.writeRaw(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      }
    } catch (err) {
      if (!this.closed) {
        await this.writeRaw(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err instanceof Error ? err.message : "inbound_request_failed" },
          }) + "\n"
        ).catch(() => {});
      }
    }
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

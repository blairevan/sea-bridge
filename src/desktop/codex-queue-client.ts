import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface QueueResult {
  status: "delivered" | "failed" | "delivery_unknown";
  exitCode: number | null;
  errorCode?: string;
  queueItemId?: string;
}

export interface QueueDeliveryContext { source: "web" | "telegram"; updateId?: number; }
export interface QueueDeliveryTrace {
  deliveryId: string; threadId: string; source: "web" | "telegram" | "unknown";
  submittedAt: number; messageLength: number; updateId?: number;
}
export interface QueueDeliveryDetails { durationMs: number; signal: NodeJS.Signals | null; stderrPresent: boolean; }
export interface QueueDeliveryDiagnostics {
  submitted(trace: QueueDeliveryTrace): void;
  settled(trace: QueueDeliveryTrace, result: QueueResult, details: QueueDeliveryDetails): void;
}

type ProcessResult = { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; stdout?: string; timedOut?: boolean };
type ProcessRunner = (command: string, args: string[], timeoutMs: number) => Promise<ProcessResult>;

/** Bound queue admission and settle only after the subprocess exits or fails to spawn. */
function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = ""; let stdout = ""; let settled = false; let timedOut = false;
    /** Release the deadline and pipe once, including spawn-error and exit races. */
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return; settled = true; clearTimeout(timer); child.stderr.destroy(); child.stdout.destroy();
      resolve({ exitCode, signal, stderr, stdout, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode, child.signalCode);
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 4096) stdout += chunk.slice(0, 4096 - stdout.length);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => { stderr = String(error); finish(null, null); });
    child.once("exit", (code, signal) => { if (timedOut) finish(code, signal); });
    child.once("close", finish);
  });
}

/** Extract only a known native receipt for the requested thread; never expose raw output. */
function receiptId(stdout: string | undefined, threadId: string): string | undefined {
  const match = /^Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})\.$/i.exec(stdout?.trim() ?? "");
  return match?.[2] === threadId ? match[1] : undefined;
}

/** Diagnostic failures must never change message admission or cause a retry. */
function observe(action: () => void): void {
  try { action(); } catch { /* Preserve the original delivery result. */ }
}

export class ProcessCodexQueueClient {
  /** Configure a bounded CLI admission deadline without changing message arguments. */
  constructor(
    private readonly codexCliPath: string,
    private readonly runner: ProcessRunner = runProcess,
    private readonly timeoutMs = 15_000,
    private readonly diagnostics?: QueueDeliveryDiagnostics,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("queue_timeout_invalid");
  }

  /** Queue once; a timed-out process cannot prove whether admission already happened. */
  async queue(threadId: string, text: string, context?: QueueDeliveryContext): Promise<QueueResult> {
    const trace: QueueDeliveryTrace = { deliveryId: randomUUID(), threadId, source: context?.source ?? "unknown",
      submittedAt: Date.now(), messageLength: text.length, ...(context?.updateId === undefined ? {} : { updateId: context.updateId }) };
    observe(() => this.diagnostics?.submitted(trace));
    const result = await this.runner(this.codexCliPath, ["queue", "--thread", threadId, "--message", text], this.timeoutMs);
    let outcome: QueueResult;
    if (result.timedOut) outcome = { status: "delivery_unknown", exitCode: null, errorCode: "codex_queue_timeout" };
    else if (result.exitCode === 0 && result.signal === null) {
      const id = receiptId(result.stdout, threadId);
      outcome = { status: "delivered", exitCode: 0, ...(id ? { queueItemId: id } : {}) };
    } else if (result.exitCode === null) outcome = { status: "delivery_unknown", exitCode: null, errorCode: "process_no_exit_code" };
    else outcome = { status: "failed", exitCode: result.exitCode, errorCode: "codex_queue_nonzero_exit" };
    observe(() => this.diagnostics?.settled(trace, outcome, { durationMs: Date.now() - trace.submittedAt,
      signal: result.signal, stderrPresent: Boolean(result.stderr) }));
    return outcome;
  }
}

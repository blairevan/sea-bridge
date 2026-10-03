import { spawn } from "node:child_process";

export interface QueueResult {
  status: "delivered" | "failed" | "delivery_unknown";
  exitCode: number | null;
  errorCode?: string;
}

type ProcessResult = { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut?: boolean };
type ProcessRunner = (command: string, args: string[], timeoutMs: number) => Promise<ProcessResult>;

/** Bound queue admission and settle only after the subprocess exits or fails to spawn. */
function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = ""; let settled = false; let timedOut = false;
    /** Release the deadline and pipe once, including spawn-error and exit races. */
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return; settled = true; clearTimeout(timer); child.stderr.destroy();
      resolve({ exitCode, signal, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => { stderr = String(error); finish(null, null); });
    child.once("exit", finish);
  });
}

export class ProcessCodexQueueClient {
  /** Configure a bounded CLI admission deadline without changing message arguments. */
  constructor(
    private readonly codexCliPath: string,
    private readonly runner: ProcessRunner = runProcess,
    private readonly timeoutMs = 15_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("queue_timeout_invalid");
  }

  /** Queue once; a timed-out process cannot prove whether admission already happened. */
  async queue(threadId: string, text: string): Promise<QueueResult> {
    const result = await this.runner(this.codexCliPath, ["queue", "--thread", threadId, "--message", text], this.timeoutMs);
    if (result.timedOut) return { status: "delivery_unknown", exitCode: null, errorCode: "codex_queue_timeout" };
    if (result.exitCode === 0 && result.signal === null) return { status: "delivered", exitCode: 0 };
    if (result.exitCode === null) return { status: "delivery_unknown", exitCode: null, errorCode: "process_no_exit_code" };
    return { status: "failed", exitCode: result.exitCode, errorCode: "codex_queue_nonzero_exit" };
  }
}

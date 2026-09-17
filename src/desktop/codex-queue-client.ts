import { spawn } from "node:child_process";

export interface QueueResult {
  status: "delivered" | "failed" | "delivery_unknown";
  exitCode: number | null;
  errorCode?: string;
}

type ProcessResult = { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string };
type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>;

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => resolve({ exitCode: null, signal: null, stderr: String(error) }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stderr }));
  });
}

export class ProcessCodexQueueClient {
  constructor(
    private readonly codexCliPath: string,
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  async queue(threadId: string, text: string): Promise<QueueResult> {
    const result = await this.runner(this.codexCliPath, ["queue", "--thread", threadId, "--message", text]);
    if (result.exitCode === 0 && result.signal === null) return { status: "delivered", exitCode: 0 };
    if (result.exitCode === null) return { status: "delivery_unknown", exitCode: null, errorCode: "process_no_exit_code" };
    return { status: "failed", exitCode: result.exitCode, errorCode: "codex_queue_nonzero_exit" };
  }
}

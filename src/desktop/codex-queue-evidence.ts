import { execFile } from "node:child_process";
import { readCodexTranscript, type CodexActivity } from "../web/codex-transcript.ts";

export interface QueueInputEvidence {
  turnId: string; observedAt: number; state: "input_observed" | "started" | "completed" | "interrupted";
  startedAt: number | null; completedAt: number | null;
}
export interface QueueExecutionEvidence {
  available: boolean; activity: CodexActivity | null; matches: Map<string, QueueInputEvidence>;
}
export interface CodexProcessSnapshot {
  available: boolean; desktopPids: number[]; codexChildPids: number[];
  rolloutHandleReadAvailable?: boolean; rolloutOpenPids?: number[];
}

/** Extract only client/turn identifiers and lifecycle times from the confined bounded native reader. */
export async function readQueueExecutionEvidence(path: string, roots: readonly string[], clientIds: readonly string[]): Promise<QueueExecutionEvidence> {
  const wanted = new Set(clientIds);
  const inputs = new Map<string, { turnId: string; observedAt: number; offset: number }>();
  const turns = new Map<string, { startedAt: number | null; completedAt: number | null; interrupted: boolean }>();
  let activity: CodexActivity | null = null; let latestOffset = -1;
  try {
    await readCodexTranscript(path, roots, null, 100, (line, offset) => {
      let value: unknown; try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (row.type !== "event_msg" || typeof row.timestamp !== "string" || !row.payload || typeof row.payload !== "object") return;
      const payload = row.payload as Record<string, unknown>; const at = Date.parse(row.timestamp);
      if (typeof payload.turn_id !== "string" || !Number.isFinite(at)) return;
      if (["task_started", "task_complete", "turn_aborted"].includes(String(payload.type))) {
        const turn = turns.get(payload.turn_id) ?? { startedAt: null, completedAt: null, interrupted: false };
        if (payload.type === "task_started") turn.startedAt = at;
        else { turn.completedAt = at; turn.interrupted = payload.type === "turn_aborted"; }
        turns.set(payload.turn_id, turn);
        if (offset > latestOffset) {
          latestOffset = offset; activity = { state: payload.type === "task_started" ? "active" : "idle", turnId: payload.turn_id, observedAt: at };
        }
      }
      if (payload.type !== "item_completed" || !payload.item || typeof payload.item !== "object") return;
      const item = payload.item as Record<string, unknown>;
      if (item.type !== "UserMessage" || typeof item.client_id !== "string" || !wanted.has(item.client_id)) return;
      if ((inputs.get(item.client_id)?.offset ?? -1) < offset) inputs.set(item.client_id, { turnId: payload.turn_id, observedAt: at, offset });
    });
    const matches = new Map<string, QueueInputEvidence>();
    for (const [id, input] of inputs) {
      const turn = turns.get(input.turnId);
      matches.set(id, { turnId: input.turnId, observedAt: input.observedAt, startedAt: turn?.startedAt ?? null,
        completedAt: turn?.completedAt ?? null, state: turn?.completedAt != null ? turn.interrupted ? "interrupted" : "completed"
          : turn?.startedAt != null ? "started" : "input_observed" });
    }
    return { available: true, activity, matches };
  } catch { return { available: false, activity: null, matches: new Map() }; }
}

/** Inspect macOS process identifiers without reading command arguments, focusing windows or sending RPCs. */
export async function readCodexProcesses(): Promise<CodexProcessSnapshot> {
  if (process.platform !== "darwin") return { available: false, desktopPids: [], codexChildPids: [] };
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,comm="], { timeout: 1000, maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error) { resolve({ available: false, desktopPids: [], codexChildPids: [] }); return; }
      const rows = stdout.split("\n").flatMap((line) => {
        const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), command: row[3] ?? "" }] : [];
      });
      const desktopPids = rows.filter((row) => /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT$/.test(row.command)).map((row) => row.pid);
      const codexChildPids = rows.filter((row) => desktopPids.includes(row.ppid) && row.command.endsWith("/codex")).map((row) => row.pid);
      resolve({ available: true, desktopPids, codexChildPids });
    });
  });
}

/** Inspect file-handle PIDs only; an absent handle is a clue, not proof of a thread's runtime status. */
export async function readRolloutOpenPids(path: string): Promise<{ available: boolean; pids: number[] }> {
  if (process.platform !== "darwin") return { available: false, pids: [] };
  return new Promise((resolve) => {
    execFile("/usr/sbin/lsof", ["-t", "--", path], { timeout: 1000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error && !(error.code === 1 && !stderr.trim())) { resolve({ available: false, pids: [] }); return; }
      resolve({ available: true, pids: stdout.split("\n").filter((line) => /^\d+$/.test(line)).map(Number) });
    });
  });
}

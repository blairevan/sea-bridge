import { execFile } from "node:child_process";

/** Invoke Launch Services with fixed arguments and a bounded deadline; never use a shell. */
export function openCodexDesktopThread(id: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return Promise.reject(new Error("invalid_session_id"));
  if (process.platform !== "darwin") return Promise.reject(new Error("desktop_open_unavailable"));
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", ["codex://threads/" + id], { timeout: 5000, maxBuffer: 4096 }, (error) => {
      if (error) reject(new Error("desktop_open_failed")); else resolve();
    });
  });
}

import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AntigravityDesktopReader } from "./desktop-reader.ts";
import { createAntigravityCallback } from "./menu-ui.ts";
import { isValidDesktopConversationId } from "./policy.ts";
import type { TelegramHandlerClient } from "./telegram-handler.ts";
import type { AntigravityTelegramStore } from "./telegram-store.ts";

export interface CommandExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[], timeoutMs?: number) => Promise<CommandExecResult>;

/** Default child-process command runner with timeout protection. */
export async function defaultCommandRunner(cmd: string, args: string[], timeoutMs = 4000): Promise<CommandExecResult> {
  return await new Promise<CommandExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ exitCode: 124, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Coordinates post-turn `Antigravity.app` refresh for Desktop sessions:
 * - Keeps `Antigravity.app` open while background `agy acp` turns execute (so users can work on other sessions).
 * - Once the background turn finishes and releases `<sessionId>.lock`, checks if `Antigravity.app` holds `<sessionId>` in memory:
 *   - If no other desktop session is running, performs a fast 1–2s restart (`quit` -> `open`) to reload `<sessionId>.db`.
 *   - If another desktop session is actively running, sends a `[🔄 立即重启桌面端同步显示]` button in Telegram instead of interrupting.
 */
export class AntigravityDesktopAppController {
  private readonly pendingRefreshBySession = new Map<string, { chatId: string | number }>();
  private readonly runCommand: CommandRunner;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: {
      desktopAppDataDir: string;
      desktopReader?: Pick<AntigravityDesktopReader, "listSessions"> | undefined;
      tgStore: AntigravityTelegramStore;
      telegram: TelegramHandlerClient;
      appBundlePath?: string | undefined;
      runCommand?: CommandRunner | undefined;
      sleepFn?: ((ms: number) => Promise<void>) | undefined;
    }
  ) {
    this.runCommand = deps.runCommand ?? defaultCommandRunner;
    this.sleepFn = deps.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Return `true` if `Antigravity.app` currently holds `<sessionId>.lock` or `<sessionId>.db` open in memory. */
  async isSessionOpenInDesktopApp(sessionId: string): Promise<boolean> {
    if (!isValidDesktopConversationId(sessionId)) return false;
    const lockPath = path.join(this.deps.desktopAppDataDir, "presence", `${sessionId}.lock`);
    const dbPath = path.join(this.deps.desktopAppDataDir, "conversations", `${sessionId}.db`);
    const walPath = path.join(this.deps.desktopAppDataDir, "conversations", `${sessionId}.db-wal`);
    const targets = [dbPath, walPath, lockPath].filter((p) => existsSync(p));
    if (targets.length === 0) return false;

    // Note: macOS `lsof` returns exitCode 1 if ANY listed file has no open handles,
    // even when other listed files DO have open handles and print PIDs to stdout.
    const lsofRes = await this.runCommand("lsof", ["-t", "--", ...targets], 3000);
    if (!lsofRes.stdout.trim()) return false;
    const pids = Array.from(
      new Set(
        lsofRes.stdout
          .split(/\s+/)
          .map((s) => s.trim())
          .filter((s) => /^\d+$/.test(s))
      )
    );
    if (pids.length === 0) return false;

    const psRes = await this.runCommand("ps", ["-p", pids.join(","), "-o", "args="], 2000);
    if (psRes.exitCode !== 0) return false;
    return psRes.stdout
      .split("\n")
      .some((line) => line.includes("Antigravity.app") || (line.includes("language_server") && !line.includes("acp")));
  }

  /** Return `true` if another Desktop conversation (`!== excludeSessionId`) is currently running in `Antigravity.app`. */
  hasOtherRunningDesktopSession(excludeSessionId: string): boolean {
    if (!this.deps.desktopReader) return false;
    try {
      return this.deps.desktopReader
        .listSessions(100)
        .some((s) => s.id !== excludeSessionId && s.state === "running");
    } catch {
      return false;
    }
  }

  /** Gracefully quit `Antigravity.app` and wait until both the Electron app and `language_server` exit. */
  async quitDesktopApp(sessionId?: string): Promise<boolean> {
    await this.runCommand("osascript", ["-e", 'tell application "Antigravity" to quit'], 5000);
    const isStillAlive = async () => {
      if (await this.isDesktopAppRunning()) return true;
      if (sessionId && (await this.isSessionOpenInDesktopApp(sessionId))) return true;
      return false;
    };
    for (let i = 0; i < 20; i++) {
      if (!(await isStillAlive())) return true;
      await this.sleepFn(200);
    }
    await this.runCommand("pkill", ["-TERM", "-f", "Antigravity.app/Contents/Resources/bin/language_server"], 2000);
    await this.runCommand("pkill", ["-TERM", "-f", "Antigravity.app/Contents/MacOS/Antigravity"], 2000);
    for (let i = 0; i < 10; i++) {
      if (!(await isStillAlive())) return true;
      await this.sleepFn(200);
    }
    return false;
  }

  /** Check whether `/Applications/Antigravity.app` main process is currently running. */
  async isDesktopAppRunning(): Promise<boolean> {
    const res = await this.runCommand("pgrep", ["-f", "Antigravity.app/Contents/MacOS/Antigravity"], 2000);
    return res.exitCode === 0 && Boolean(res.stdout.trim());
  }

  /** Resolve the native Antigravity Desktop `project_id` UUID for `sessionId` from `conversation_summaries.db`. */
  resolveNativeProjectId(sessionId: string): string | null {
    if (!isValidDesktopConversationId(sessionId)) return null;
    const summariesDbPath = path.join(this.deps.desktopAppDataDir, "conversation_summaries.db");
    if (!existsSync(summariesDbPath)) return null;
    let db: Database | null = null;
    try {
      db = new Database(summariesDbPath, { readonly: true });
      const row = db
        .query("SELECT project_id FROM conversation_summaries WHERE conversation_id = ? LIMIT 1")
        .get(sessionId) as { project_id?: string | null } | null;
      const projectId = typeof row?.project_id === "string" ? row.project_id.trim() : "";
      return projectId || null;
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  /** Reopen `Antigravity.app` on macOS, deep-linking to the session's native project when available. */
  async reopenDesktopApp(sessionId?: string): Promise<boolean> {
    const bundle = this.deps.appBundlePath ?? "/Applications/Antigravity.app";
    const baseArgs = existsSync(bundle) ? ["-a", bundle] : ["-a", "Antigravity"];
    const nativeProjectId = sessionId ? this.resolveNativeProjectId(sessionId) : null;
    const deepLink = nativeProjectId ? `antigravity://open?project=${encodeURIComponent(nativeProjectId)}` : null;
    const args = deepLink ? [...baseArgs, deepLink, "--args", deepLink] : baseArgs;
    const res = await this.runCommand("open", args, 5000);
    return res.exitCode === 0;
  }

  /** Perform a fast 1–2s restart of `Antigravity.app` (`quit` -> `open`) so it reloads `<sessionId>.db` from disk. */
  async restartDesktopApp(sessionId?: string): Promise<boolean> {
    const quitOk = await this.quitDesktopApp(sessionId);
    if (!quitOk) return false;
    await this.sleepFn(150);
    return await this.reopenDesktopApp(sessionId);
  }

  /** Mark a Desktop session to be refreshed in `Antigravity.app` once its background `agy acp` turn finishes. */
  markRefreshAfterTurn(sessionId: string, chatId: string | number): void {
    this.pendingRefreshBySession.set(sessionId, { chatId });
  }

  /** Cancel a scheduled post-turn refresh for a session. */
  cancelScheduledRefresh(sessionId: string): void {
    this.pendingRefreshBySession.delete(sessionId);
  }

  /**
   * Invoked when a Desktop session turn finishes and its `agy acp` worker has closed:
   * - If `Antigravity.app` does not have `<sessionId>` open in memory, no action needed.
   * - If another Desktop session is currently running, sends a manual refresh button in Telegram to avoid interrupting it.
   * - Otherwise, performs an automatic 1–2s restart of `Antigravity.app` so the completed turn appears immediately.
   */
  async onDesktopTurnSettled(sessionId: string): Promise<void> {
    const pending = this.pendingRefreshBySession.get(sessionId);
    if (!pending) return;
    this.pendingRefreshBySession.delete(sessionId);

    await this.sleepFn(200);
    const openInApp = await this.isSessionOpenInDesktopApp(sessionId);
    if (!openInApp) return;

    if (this.hasOtherRunningDesktopSession(sessionId)) {
      await this.sendDeferredRestartPrompt(String(pending.chatId), sessionId, "检测到 Antigravity 桌面端当前有其他会话正在执行任务，未自动重启。");
      return;
    }

    const restarted = await this.restartDesktopApp(sessionId);
    if (!restarted) {
      await this.sendDeferredRestartPrompt(String(pending.chatId), sessionId, "未能自动重启 Antigravity 桌面端以刷新该会话显示。");
    }
  }

  /** Send an inline button allowing the user to trigger a 1–2s `Antigravity.app` restart on demand. */
  async sendDeferredRestartPrompt(chatId: string, sessionId: string, reasonText: string): Promise<void> {
    const cb = createAntigravityCallback(
      this.deps.tgStore,
      chatId,
      "desktop.reply.decide",
      { decision: "refresh_now", sessionId },
      Date.now(),
      24 * 60 * 60_000
    );
    const shortId = `${sessionId.slice(0, 7)}…${sessionId.slice(-4)}`;
    await this.deps.telegram.sendMessage(
      chatId,
      `${reasonText}\n会话 ${shortId} 的回复已写入磁盘，点击下方按钮可立即重启桌面端同步显示：`,
      [[{ text: "🔄 立即重启桌面端同步显示", callback_data: cb }]]
    );
  }

  /** Handle the user clicking `[🔄 立即重启桌面端同步显示]`. */
  async handleCallback(
    chatId: number,
    sourceMessageId: number | undefined,
    payload: Record<string, unknown>,
    _replyRouter?: unknown
  ): Promise<void> {
    if (sourceMessageId !== undefined) {
      await this.deps.telegram.editMessageReplyMarkup(chatId, sourceMessageId, []).catch(() => undefined);
    }
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const notify = async (msg: string) => {
      if (sourceMessageId !== undefined) {
        await this.deps.telegram.editMessageText(chatId, sourceMessageId, msg, []).catch(async () => {
          await this.deps.telegram.sendMessage(chatId, msg);
        });
      } else {
        await this.deps.telegram.sendMessage(chatId, msg);
      }
    };

    await notify("⏳ 正在重启 Antigravity 桌面端以加载最新对话…");
    const ok = await this.restartDesktopApp(sessionId || undefined);
    await notify(
      ok
        ? "✅ 已重启 Antigravity 桌面端，最新对话已同步显示。"
        : "⚠️ 未能自动重启 Antigravity 桌面端（可能存在未保存确认弹窗），请手动按 Cmd+Q 重启桌面端。"
    );
  }
}

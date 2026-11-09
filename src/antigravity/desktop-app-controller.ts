import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createAntigravityCallback } from "./menu-ui.ts";
import { isValidDesktopConversationId } from "./policy.ts";
import type { AntigravityReplyRouter } from "./reply-router.ts";
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
 * Coordinates `Antigravity.app` lifecycle around Telegram replies to Desktop sessions:
 * 1. Checks whether `Antigravity.app`'s `language_server` holds `<sessionId>.lock` / `<sessionId>.db` in memory.
 * 2. Prompts the user in Telegram with inline buttons (`restart` / `direct` / `cancel`).
 * 3. Gracefully quits `Antigravity.app` before running `agy acp` and reopens `Antigravity.app` once the turn settles.
 */
export class AntigravityDesktopAppController {
  private readonly pendingReopenBySession = new Map<string, { chatId: string | number }>();
  private readonly consumedDecisionGroups = new Set<string>();
  private readonly runCommand: CommandRunner;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: {
      desktopAppDataDir: string;
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
    const targets = [lockPath, dbPath].filter((p) => existsSync(p));
    if (targets.length === 0) return false;

    const lsofRes = await this.runCommand("lsof", ["-t", "--", ...targets], 3000);
    if (lsofRes.exitCode !== 0 || !lsofRes.stdout.trim()) return false;
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

  /** Gracefully quit `Antigravity.app` and wait until its `language_server` releases the session lock. */
  async quitDesktopApp(sessionId?: string): Promise<boolean> {
    await this.runCommand("osascript", ["-e", 'tell application "Antigravity" to quit'], 5000);
    for (let i = 0; i < 15; i++) {
      const stillOpen = sessionId ? await this.isSessionOpenInDesktopApp(sessionId) : await this.isDesktopAppRunning();
      if (!stillOpen) return true;
      await this.sleepFn(200);
    }
    await this.runCommand("pkill", ["-TERM", "-f", "Antigravity.app/Contents/Resources/bin/language_server"], 2000);
    for (let i = 0; i < 10; i++) {
      const stillOpen = sessionId ? await this.isSessionOpenInDesktopApp(sessionId) : await this.isDesktopAppRunning();
      if (!stillOpen) return true;
      await this.sleepFn(200);
    }
    return false;
  }

  /** Check whether `/Applications/Antigravity.app` main process is currently running. */
  async isDesktopAppRunning(): Promise<boolean> {
    const res = await this.runCommand("pgrep", ["-f", "Antigravity.app/Contents/MacOS/Antigravity"], 2000);
    return res.exitCode === 0 && Boolean(res.stdout.trim());
  }

  /** Reopen `Antigravity.app` on macOS. */
  async reopenDesktopApp(): Promise<boolean> {
    const bundle = this.deps.appBundlePath ?? "/Applications/Antigravity.app";
    const args = existsSync(bundle) ? ["-a", bundle] : ["-a", "Antigravity"];
    const res = await this.runCommand("open", args, 5000);
    return res.exitCode === 0;
  }

  /** Schedule `Antigravity.app` to reopen once the desktop session turn finishes and closes its ACP worker. */
  scheduleReopenAfterTurn(sessionId: string, chatId: string | number): void {
    this.pendingReopenBySession.set(sessionId, { chatId });
  }

  /** Cancel a scheduled reopen for a session. */
  cancelScheduledReopen(sessionId: string): void {
    this.pendingReopenBySession.delete(sessionId);
  }

  /** Invoked when a desktop session turn finishes and its `agy acp` worker has closed. */
  async onDesktopTurnSettled(sessionId: string): Promise<void> {
    const pending = this.pendingReopenBySession.get(sessionId);
    if (!pending) return;
    this.pendingReopenBySession.delete(sessionId);
    await this.sleepFn(250);
    await this.reopenDesktopApp();
  }

  /** Send a Telegram inline-button prompt asking whether to close `Antigravity.app` before sending. */
  async sendConfirmationPrompt(input: {
    updateId: number;
    chatId: string;
    replyToMessageId: number;
    sessionId: string;
    text: string;
  }): Promise<void> {
    const now = Date.now();
    const ttlMs = 15 * 60_000;
    const groupKey = `${input.chatId}:${input.updateId}`;
    const basePayload = {
      groupKey,
      updateId: input.updateId,
      replyToMessageId: input.replyToMessageId,
      sessionId: input.sessionId,
      text: input.text,
    };
    const restartCb = createAntigravityCallback(
      this.deps.tgStore,
      input.chatId,
      "desktop.reply.decide",
      { ...basePayload, decision: "restart" },
      now,
      ttlMs
    );
    const directCb = createAntigravityCallback(
      this.deps.tgStore,
      input.chatId,
      "desktop.reply.decide",
      { ...basePayload, decision: "direct" },
      now,
      ttlMs
    );
    const cancelCb = createAntigravityCallback(
      this.deps.tgStore,
      input.chatId,
      "desktop.reply.decide",
      { ...basePayload, decision: "cancel" },
      now,
      ttlMs
    );

    const shortId = `${input.sessionId.slice(0, 7)}…${input.sessionId.slice(-4)}`;
    await this.deps.telegram.sendMessage(
      input.chatId,
      [
        `⚠️ 会话 ${shortId} 当前已在 Antigravity 桌面端打开`,
        "若需在桌面端窗口同步显示本次回复，请先关闭桌面端，待本轮回复完成后将自动重新启动 Antigravity。",
      ].join("\n"),
      [
        [{ text: "🔄 关闭桌面端 → 发送 → 自动重启 (推荐)", callback_data: restartCb }],
        [{ text: "📨 不关桌面端直接发送 (仅写盘)", callback_data: directCb }],
        [{ text: "❌ 取消", callback_data: cancelCb }],
      ]
    );
  }

  /** Handle the user's button selection (`restart`, `direct`, or `cancel`). */
  async handleCallback(
    chatId: number,
    sourceMessageId: number | undefined,
    payload: Record<string, unknown>,
    replyRouter: AntigravityReplyRouter
  ): Promise<void> {
    const groupKey = typeof payload.groupKey === "string" ? payload.groupKey : "";
    if (groupKey) {
      if (this.consumedDecisionGroups.has(groupKey)) return;
      this.consumedDecisionGroups.add(groupKey);
    }
    if (sourceMessageId !== undefined) {
      await this.deps.telegram.editMessageReplyMarkup(chatId, sourceMessageId, []).catch(() => undefined);
    }

    const decision = typeof payload.decision === "string" ? payload.decision : "cancel";
    const updateId = Number(payload.updateId);
    const replyToMessageId = Number(payload.replyToMessageId);
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const text = typeof payload.text === "string" ? payload.text : "";

    const notify = async (msg: string) => {
      if (sourceMessageId !== undefined) {
        await this.deps.telegram.editMessageText(chatId, sourceMessageId, msg, []).catch(async () => {
          await this.deps.telegram.sendMessage(chatId, msg);
        });
      } else {
        await this.deps.telegram.sendMessage(chatId, msg);
      }
    };

    if (decision === "cancel" || !sessionId || !text || !Number.isSafeInteger(updateId)) {
      await notify("已取消本次 Antigravity 桌面会话投递。");
      return;
    }

    if (decision === "direct") {
      const res = await replyRouter.deliver(updateId, String(chatId), replyToMessageId, text, {
        bypassDesktopOpenCheck: true,
      });
      await notify(
        res.status === "delivered"
          ? "已投递到对应的 Antigravity 会话（未关闭桌面端，仅写入磁盘）。"
          : res.status === "session_busy"
            ? "Antigravity 会话当前正在执行任务，本条内容未排队、未自动重试。"
            : "Antigravity 拒绝了本次投递，未自动重试。"
      );
      return;
    }

    await notify("⏳ 正在关闭 Antigravity 桌面端并投递消息，待本轮回复完成后将自动重新启动 Antigravity…");
    const quitOk = await this.quitDesktopApp(sessionId);
    if (!quitOk) {
      await notify("⚠️ 未能自动关闭 Antigravity 桌面端（可能存在未保存确认弹窗），本次消息未发送。");
      return;
    }

    this.scheduleReopenAfterTurn(sessionId, chatId);
    const res = await replyRouter.deliver(updateId, String(chatId), replyToMessageId, text, {
      bypassDesktopOpenCheck: true,
    });
    if (res.status === "delivered") {
      await notify("✅ 已关闭 Antigravity 桌面端并投递消息；待本轮回复完成后将自动重新启动 Antigravity。");
      return;
    }

    this.cancelScheduledReopen(sessionId);
    await this.reopenDesktopApp();
    await notify(
      res.status === "session_busy"
        ? "Antigravity 会话当前正在执行任务，本条内容未发送；已重新启动 Antigravity 桌面端。"
        : "Antigravity 投递未成功；已重新启动 Antigravity 桌面端。"
    );
  }
}

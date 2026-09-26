import { createHash } from "node:crypto";
import type { Logger } from "../logger.ts";
import { redact } from "../security/redact.ts";
import type { DesktopMessageEventKind, DesktopMessageStore } from "../state/desktop-message-store.ts";
import type { InlineButton, TelegramClient } from "../telegram/client.ts";
import type { CodexThread, CodexThreadReader } from "./codex-thread-store.ts";
import type { DesktopThreadTurn, ThreadHistoryReader } from "./thread-history-store.ts";

const SCHEMA_FINGERPRINT = "codex-thread-history-0.154.0-alpha.6.2-v1";

interface DesktopTurnEvent {
  turnId: string;
  kind: DesktopMessageEventKind;
  finalText: string | null;
  fingerprint: string;
}

function turnEvent(threadId: string, turn: DesktopThreadTurn): DesktopTurnEvent | null {
  const kind: DesktopMessageEventKind | null = turn.status === "completed"
    ? "completed"
    : turn.status === "failed"
      ? "failed"
      : turn.status === "interrupted"
        ? "interrupted"
        : null;
  if (!kind) return null;
  return {
    turnId: turn.turnId,
    kind,
    finalText: turn.finalText,
    fingerprint: createHash("sha256").update(JSON.stringify({ threadId, turnId: turn.turnId, kind, finalText: turn.finalText, ordinal: turn.ordinal })).digest("hex"),
  };
}

function summary(value: string | null, maxChars: number): string | null {
  if (!value) return null;
  const redacted = redact(value);
  const text = typeof redacted === "string" ? redacted : "";
  if (!text) return null;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n内容已截断`;
}

function notificationText(thread: CodexThread, event: DesktopTurnEvent, maxChars: number): string {
  const labels: Record<DesktopMessageEventKind, string> = {
    started: "开始执行",
    waiting_for_input: "等待输入",
    completed: "执行完成",
    failed: "执行失败",
    interrupted: "已中断",
    reply_prompt: "等待回复",
    thread_created: "已创建",
  };
  return [`Codex: ${thread.title}`, `状态: ${labels[event.kind]}`, summary(event.finalText, maxChars)]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export class DesktopObserver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private initialized = false;

  constructor(
    private readonly threads: CodexThreadReader,
    private readonly history: ThreadHistoryReader,
    private readonly messages: DesktopMessageStore,
    private readonly telegram: Pick<TelegramClient, "sendMessage">,
    private readonly chatId: string,
    private readonly logger: Logger,
    private readonly pollIntervalMs: number,
    private readonly summaryMaxChars: number,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runScheduledPoll();
    this.timer = setInterval(() => void this.runScheduledPoll(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    const threads = this.threads.listActive();
    if (!this.initialized) {
      const threadsNeedingBaseline = threads.filter((t) => !this.messages.getCursor(t.id));
      if (threadsNeedingBaseline.length > 0) {
        const baseline = this.history.latestOrdinals(threadsNeedingBaseline.map((thread) => thread.id));
        for (const thread of threadsNeedingBaseline) this.baselineThread(thread, baseline.get(thread.id) ?? 0);
      }
      this.initialized = true;
      this.logger.info("desktop_observer_baselined", {
        threadCount: threads.length,
        newlyBaselined: threadsNeedingBaseline.length,
      });
    }
    for (const thread of threads) await this.observeThread(thread);
    this.initialized = true;
  }

  private async runScheduledPoll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (error) {
      this.logger.warn("desktop_observer_poll_failed", { error: String(error) });
    } finally {
      this.polling = false;
    }
  }

  private async observeThread(thread: CodexThread): Promise<void> {
    const cursor = this.messages.getCursor(thread.id);
    if (!cursor) {
      this.baselineThread(thread, this.history.latestOrdinal(thread.id));
      return;
    }

    const turns = this.history.listTurnsAfter(thread.id, cursor.byteOffset);
    let lastEventFingerprint = cursor.lastEventFingerprint;
    for (const turn of turns) {
      const event = turnEvent(thread.id, turn);
      if (!event) continue;
      lastEventFingerprint = event.fingerprint;
      if (this.messages.hasEventFingerprint(event.fingerprint)) continue;
      const buttons: InlineButton[][] = [[{ text: "💬 回复", callback_data: "reply:" + thread.id }]];
      const message = await this.telegram.sendMessage(this.chatId, notificationText(thread, event, this.summaryMaxChars), buttons, false);
      this.messages.link({
        chatId: this.chatId,
        messageId: message.message_id,
        threadId: thread.id,
        turnId: event.turnId,
        eventKind: event.kind,
        eventFingerprint: event.fingerprint,
      });
      this.logger.info("desktop_message_notified", { threadId: thread.id, turnId: event.turnId, kind: event.kind });
    }
    this.messages.saveCursor({
      threadId: thread.id,
      rolloutPath: thread.rolloutPath,
      byteOffset: turns.at(-1)?.ordinal ?? cursor.byteOffset,
      schemaFingerprint: SCHEMA_FINGERPRINT,
      lastEventFingerprint,
    });
  }

  private baselineThread(thread: CodexThread, ordinal: number): void {
    this.messages.saveCursor({
      threadId: thread.id,
      rolloutPath: thread.rolloutPath,
      byteOffset: ordinal,
      schemaFingerprint: SCHEMA_FINGERPRINT,
      lastEventFingerprint: null,
    });
  }
}

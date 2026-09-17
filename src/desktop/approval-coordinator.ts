import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { StateDb } from "../state/db.ts";
import type { TelegramClient } from "../telegram/client.ts";
import type { Logger } from "../logger.ts";
import type { CodexHookEvent } from "./hook-types.ts";
import { redactedJson } from "../security/redact.ts";

export type ApprovalDecision = "allow" | "deny";
export interface ApprovalResolution { approvalId: string; decision: ApprovalDecision; }

interface PendingWaiter {
  resolve: (decision: ApprovalResolution | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function short(value: string | undefined): string {
  if (!value) return "-";
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export class ApprovalCoordinator {
  private readonly waiters = new Map<string, PendingWaiter>();

  constructor(
    private readonly state: StateDb,
    private readonly telegram: TelegramClient,
    private readonly chatId: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async request(eventHash: string, event: CodexHookEvent): Promise<ApprovalResolution | null> {
    if (!event.turn_id) {
      this.logger.warn("approval_missing_turn_id", { sessionId: short(event.session_id) });
      return null;
    }

    const existing = this.state.db.query("SELECT status FROM pending_approvals WHERE event_hash=?").get(eventHash) as { status: string } | null;
    if (existing) {
      this.logger.warn("approval_duplicate_hook", { eventHash: eventHash.slice(0, 12), status: existing.status });
      return null;
    }

    const id = randomUUID();
    const callbackToken = randomBytes(18).toString("base64url");
    const expiresAt = Date.now() + this.timeoutMs;
    this.state.db.query(`
      INSERT INTO pending_approvals(id,event_hash,session_id,turn_id,tool_name,status,created_at,expires_at,telegram_chat_id,callback_token_hash)
      VALUES (?,?,?,?,?,'pending',?,?,?,?)
    `).run(
      id,
      eventHash,
      event.session_id,
      event.turn_id,
      event.tool_name ?? null,
      Date.now(),
      expiresAt,
      this.chatId,
      tokenHash(callbackToken),
    );

    const toolInput = redactedJson(event.tool_input ?? {}, 1800);
    const text = [
      "Codex Desktop 请求审批",
      `Session: ${short(event.session_id)}`,
      `Turn: ${short(event.turn_id)}`,
      `Tool: ${event.tool_name ?? "unknown"}`,
      event.cwd ? `CWD: ${event.cwd}` : null,
      `Input: ${toolInput}`,
      `有效期: ${Math.ceil(this.timeoutMs / 1000)} 秒`,
    ].filter(Boolean).join("\n");

    let messageId: number;
    try {
      const message = await this.telegram.sendMessage(this.chatId, text, [[
        { text: "✅ Allow", callback_data: `ap:${callbackToken}:a` },
        { text: "❌ Deny", callback_data: `ap:${callbackToken}:d` },
      ]]);
      messageId = message.message_id;
      this.state.db.query("UPDATE pending_approvals SET telegram_message_id=? WHERE id=?").run(messageId, id);
    } catch (error) {
      this.state.db.query("UPDATE pending_approvals SET status='stale' WHERE id=?").run(id);
      this.logger.error("approval_telegram_send_failed", { error: String(error), id });
      return null;
    }

    return await new Promise<ApprovalResolution | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        this.state.db.query("UPDATE pending_approvals SET status='expired' WHERE id=? AND status='pending'").run(id);
        void this.telegram.editMessageReplyMarkup(this.chatId, messageId).catch(() => undefined);
        resolve(null);
      }, this.timeoutMs);
      this.waiters.set(id, { resolve, timer });
    });
  }

  async resolveCallback(rawToken: string, decision: ApprovalDecision): Promise<"resolved" | "stale" | "invalid"> {
    const hash = tokenHash(rawToken);
    const row = this.state.db.query(`
      SELECT id,status,expires_at,telegram_message_id FROM pending_approvals WHERE callback_token_hash=?
    `).get(hash) as { id: string; status: string; expires_at: number; telegram_message_id: number | null } | null;
    if (!row) return "invalid";
    if (row.status !== "pending" || row.expires_at < Date.now()) return "stale";

    const result = this.state.db.query(`
      UPDATE pending_approvals SET status='selected',decision=? WHERE id=? AND status='pending'
    `).run(decision, row.id);
    if (result.changes !== 1) return "stale";

    const waiter = this.waiters.get(row.id);
    if (!waiter) {
      this.state.db.query("UPDATE pending_approvals SET status='stale' WHERE id=?").run(row.id);
      return "stale";
    }

    clearTimeout(waiter.timer);
    this.waiters.delete(row.id);
    waiter.resolve({ approvalId: row.id, decision });

    if (row.telegram_message_id != null) {
      await this.telegram.editMessageReplyMarkup(this.chatId, row.telegram_message_id).catch(() => undefined);
    }
    return "resolved";
  }

  markDelivered(approvalId: string): void {
    this.state.db.query("UPDATE pending_approvals SET status='delivered' WHERE id=? AND status='selected'").run(approvalId);
  }

  markDeliveryFailed(approvalId: string): void {
    this.state.db.query("UPDATE pending_approvals SET status='stale' WHERE id=? AND status='selected'").run(approvalId);
  }
}

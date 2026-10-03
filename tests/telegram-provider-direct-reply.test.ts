import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshReplyRouter } from "../src/dsh/reply-router.ts";
import { ProcessCodexQueueClient } from "../src/desktop/codex-queue-client.ts";
import { routeProviderReply } from "../src/telegram/provider-reply-router.ts";

/** Exercise persisted routing with only the external delivery boundaries replaced. */
function setup() {
  const state = new StateDb(":memory:");
  const codex = new DesktopMessageStore(state);
  const dsh = new DshBridgeStore(state);
  const hostCalls: string[][] = [];
  const queueCalls: string[][] = [];
  const router = new DshReplyRouter({
    /** Record the exact session receiving the prompt. */
    async submitPrompt(sessionId, requestId, text) {
      hostCalls.push([sessionId, requestId, text]);
      return { status: "accepted" };
    },
  }, dsh);
  const queue = new ProcessCodexQueueClient("/codex", async (_command, args) => {
    queueCalls.push(args);
    return { exitCode: 0, signal: null, stderr: "" };
  });
  /** Persist a Codex notification in the selected chat. */
  function linkCodex(id: number, chatId = "42") {
    codex.link({ chatId, messageId: id, threadId: `codex-${id}`, turnId: null,
      eventKind: "completed", eventFingerprint: `codex-${chatId}-${id}` });
  }
  /** Persist a dsh notification, optionally simulating a delayed historical insert. */
  function linkDsh(id: number, chatId = "42", sentAt = Date.now()) {
    dsh.linkMessage({ chatId, messageId: id, sessionId: `dsh-${id}`,
      eventKind: "completed", eventFingerprint: `dsh-${chatId}-${id}` }, sentAt);
  }
  /** Route direct text or an explicit reply through the real provider router. */
  function send(updateId: number, replyTo?: number) {
    return routeProviderReply(updateId, {
      message_id: 1000 + updateId, chat: { id: 42, type: "private" }, text: "continue",
      ...(replyTo === undefined ? {} : {
        reply_to_message: { message_id: replyTo, chat: { id: 42, type: "private" } },
      }),
    }, codex, dsh, queue, router);
  }
  return { state, codex, dsh, hostCalls, queueCalls, linkCodex, linkDsh, send };
}

describe("automatic provider selection for direct Telegram text", () => {
  test("selects dsh with no Codex history and consumes duplicate updates once", async () => {
    const s = setup();
    try {
      s.linkDsh(100);
      expect(await s.send(1)).toEqual({ provider: "dsh", result: { status: "delivered", sessionId: "dsh-100" } });
      expect(await s.send(1)).toMatchObject({ provider: "dsh", result: { status: "duplicate" } });
      expect(s.hostCalls).toEqual([["dsh-100", "sea-bridge-tg-1", "continue"]]);
      expect(s.queueCalls).toEqual([]);
      expect(s.dsh.getDelivery(1)?.replyToMessageId).toBe(100);
    } finally { s.state.close(); }
  });

  test("switches providers with the latest chat notification while explicit replies override it", async () => {
    const s = setup();
    try {
      s.linkCodex(100);
      s.linkDsh(200);
      expect(await s.send(1)).toMatchObject({ provider: "dsh", result: { sessionId: "dsh-200" } });
      s.linkCodex(300);
      expect(await s.send(2)).toMatchObject({ provider: "codex", result: { threadId: "codex-300" } });
      expect(await s.send(3, 200)).toMatchObject({ provider: "dsh", result: { sessionId: "dsh-200" } });
      expect(await s.send(4, 100)).toMatchObject({ provider: "codex", result: { threadId: "codex-100" } });
      expect(s.hostCalls).toEqual([
        ["dsh-200", "sea-bridge-tg-1", "continue"], ["dsh-200", "sea-bridge-tg-3", "continue"],
      ]);
      expect(s.queueCalls.map((args) => args[2])).toEqual(["codex-300", "codex-100"]);
    } finally { s.state.close(); }
  });

  test("ignores other chats and late insertion of older messages in either provider", async () => {
    const s = setup();
    try {
      s.linkDsh(200, "42", 1);
      s.linkDsh(100, "42", Date.now() + 1000);
      s.linkCodex(150);
      s.linkDsh(900, "99");
      s.linkCodex(950, "99");
      expect(await s.send(1)).toMatchObject({ provider: "dsh", result: { sessionId: "dsh-200" } });
      s.linkCodex(300);
      s.state.db.query("UPDATE desktop_message_links SET sent_at=? WHERE telegram_message_id=150").run(Date.now() + 2000);
      expect(await s.send(2)).toMatchObject({ provider: "codex", result: { threadId: "codex-300" } });
    } finally { s.state.close(); }
  });

  test("does not dispatch a collision or an unmapped explicit reply", async () => {
    const s = setup();
    try {
      s.linkDsh(100);
      s.linkCodex(100);
      expect(await s.send(1)).toEqual({ status: "provider_conflict" });
      expect(await s.send(2, 999)).toEqual({ status: "unmapped_reply" });
      expect(s.hostCalls).toEqual([]);
      expect(s.queueCalls).toEqual([]);
    } finally { s.state.close(); }
  });

  test("returns missing_reply without history in this chat", async () => {
    const s = setup();
    try {
      s.linkDsh(100, "99");
      s.linkCodex(200, "99");
      expect(await s.send(1)).toEqual({ provider: "codex", result: { status: "missing_reply" } });
      expect(s.hostCalls).toEqual([]);
      expect(s.queueCalls).toEqual([]);
    } finally { s.state.close(); }
  });
});

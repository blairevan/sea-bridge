import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DesktopMessageStore } from "../src/state/desktop-message-store.ts";
import { DshReplyRouter } from "../src/dsh/reply-router.ts";
import { routeProviderReply } from "../src/telegram/provider-reply-router.ts";

function setup() {
  const state = new StateDb(":memory:");
  const dshStore = new DshBridgeStore(state);
  const codexStore = new DesktopMessageStore(state);
  dshStore.linkMessage({
    chatId: "42",
    messageId: 100,
    sessionId: "session-dsh",
    eventKind: "completed",
    eventFingerprint: "dsh-event",
  });
  codexStore.link({
    chatId: "42",
    messageId: 200,
    threadId: "thread-codex",
    turnId: null,
    eventKind: "completed",
    eventFingerprint: "codex-event",
  });
  return { state, dshStore, codexStore };
}

function message(text: string, replyTo?: number) {
  return {
    message_id: 999,
    chat: { id: 42, type: "private" as const },
    text,
    ...(replyTo === undefined ? {} : {
      reply_to_message: { message_id: replyTo, chat: { id: 42, type: "private" as const } },
    }),
  };
}

describe("DshReplyRouter", () => {
  test("delivers one exact mapped reply and never repeats the Host call for the same update", async () => {
    const { state, dshStore } = setup();
    const calls: unknown[] = [];
    const host = {
      submitPrompt: async (...args: unknown[]) => {
        calls.push(args);
        return { status: "accepted" as const };
      },
    };
    const router = new DshReplyRouter(host as any, dshStore);
    expect(await router.deliver(1, "42", 100, "continue")).toEqual({
      status: "delivered",
      sessionId: "session-dsh",
    });
    expect(await router.deliver(1, "42", 100, "continue")).toEqual({
      status: "duplicate",
      sessionId: "session-dsh",
    });
    expect(calls).toEqual([["session-dsh", "sea-bridge-tg-1", "continue"]]);
    expect(dshStore.getDelivery(1)?.status).toBe("delivered");
    state.close();
  });

  test("maps busy, rejection, and ambiguous transport without replay", async () => {
    for (const scenario of [
      {
        result: { status: "busy_or_writer_held" as const, errorCode: "session/agent-busy" },
        expected: "busy_or_writer_held",
        stored: "failed",
      },
      {
        result: { status: "rejected" as const, errorCode: "session_missing" },
        expected: "failed",
        stored: "failed",
      },
      {
        result: { status: "delivery_unknown" as const, errorCode: "host_write_unknown" },
        expected: "delivery_unknown",
        stored: "delivery_unknown",
      },
    ] as const) {
      const { state, dshStore } = setup();
      let calls = 0;
      const router = new DshReplyRouter({
        submitPrompt: async () => {
          calls++;
          return scenario.result;
        },
      } as any, dshStore);
      const result = await router.deliver(2, "42", 100, "hello");
      expect(result.status).toBe(scenario.expected);
      expect(dshStore.getDelivery(2)?.status).toBe(scenario.stored);
      await router.deliver(2, "42", 100, "hello");
      expect(calls).toBe(1);
      state.close();
    }

    const { state, dshStore } = setup();
    let calls = 0;
    const router = new DshReplyRouter({
      submitPrompt: async () => {
        calls++;
        throw new Error("socket lost");
      },
    } as any, dshStore);
    expect(await router.deliver(3, "42", 100, "hello")).toMatchObject({
      status: "delivery_unknown",
      errorCode: "transport_lost_after_dispatch",
    });
    await router.deliver(3, "42", 100, "hello");
    expect(calls).toBe(1);
    state.close();
  });

  test("detects duplicate update payload mismatch before a second Host write", async () => {
    const { state, dshStore } = setup();
    let calls = 0;
    const router = new DshReplyRouter({
      submitPrompt: async () => {
        calls++;
        return { status: "accepted" as const };
      },
    } as any, dshStore);
    await router.deliver(4, "42", 100, "first");
    expect(await router.deliver(4, "42", 100, "changed")).toMatchObject({
      status: "failed",
      errorCode: "duplicate_payload_mismatch",
    });
    expect(calls).toBe(1);
    state.close();
  });
});

describe("routeProviderReply", () => {
  test("routes exact dsh and exact Codex replies only to their mapped provider", async () => {
    const { state, dshStore, codexStore } = setup();
    const dshCalls: unknown[] = [];
    const codexCalls: unknown[] = [];
    const dshRouter = new DshReplyRouter({
      submitPrompt: async (...args: unknown[]) => {
        dshCalls.push(args);
        return { status: "accepted" as const };
      },
    } as any, dshStore);
    const codexQueue = {
      queue: async (...args: unknown[]) => {
        codexCalls.push(args);
        return { status: "delivered" as const, exitCode: 0, errorCode: null };
      },
    };

    const dsh = await routeProviderReply(10, message("dsh reply", 100), codexStore, dshStore, codexQueue as any, dshRouter);
    expect(dsh).toMatchObject({ provider: "dsh", result: { status: "delivered" } });
    expect(dshCalls).toHaveLength(1);
    expect(codexCalls).toHaveLength(0);

    const codex = await routeProviderReply(11, message("codex reply", 200), codexStore, dshStore, codexQueue as any, dshRouter);
    expect(codex).toMatchObject({ provider: "codex", result: { status: "delivered", threadId: "thread-codex" } });
    expect(codexCalls).toHaveLength(1);
    state.close();
  });

  test("fails closed on provider collision and preserves no-reply latest-Codex behavior", async () => {
    const { state, dshStore, codexStore } = setup();
    codexStore.link({
      chatId: "42",
      messageId: 100,
      threadId: "thread-conflict",
      turnId: null,
      eventKind: "completed",
      eventFingerprint: "conflict",
    });
    const dshRouter = new DshReplyRouter({
      submitPrompt: async () => { throw new Error("must not run"); },
    } as any, dshStore);
    const codexCalls: unknown[] = [];
    const codexQueue = {
      queue: async (...args: unknown[]) => {
        codexCalls.push(args);
        return { status: "delivered" as const, exitCode: 0, errorCode: null };
      },
    };

    expect(await routeProviderReply(12, message("collision", 100), codexStore, dshStore, codexQueue as any, dshRouter))
      .toEqual({ status: "provider_conflict" });
    expect(codexCalls).toHaveLength(0);

    codexStore.link({
      chatId: "42",
      messageId: 300,
      threadId: "thread-latest",
      turnId: null,
      eventKind: "completed",
      eventFingerprint: "latest",
    });
    const direct = await routeProviderReply(13, message("plain direct"), codexStore, dshStore, codexQueue as any, dshRouter);
    expect(direct).toMatchObject({ provider: "codex", result: { status: "delivered", threadId: "thread-latest" } });
    state.close();
  });
});

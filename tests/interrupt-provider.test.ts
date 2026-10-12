import { expect, test } from "bun:test";
import { InterruptRouter, OwnedAppServerInterruptProvider, type InterruptProvider, type InterruptTarget } from "../src/desktop/interrupt-provider.ts";

function owner(state: "running" | "interrupting" = "running") {
  return {
    turnId: "turn-a",
    state,
    terminalObserved: false,
    metadata: { model: null, sandbox: null, approvalPolicy: null },
  } as const;
}

test("owned provider exposes only an exact active turn and preserves late finished evidence", async () => {
  let current: ReturnType<typeof owner> | null = owner();
  let result: "interrupting" | "already_finished" = "interrupting";
  const calls: Array<{ threadId: string; expectedTurnId: string }> = [];
  const provider = new OwnedAppServerInterruptProvider({
    ownedTurn: () => current,
    async interruptOwnedTurn(input: InterruptTarget) { calls.push(input); return { status: result }; },
  } as any);

  expect(provider.capability({ threadId: "thread", expectedTurnId: "turn-a" })).toEqual({ status: "available" });
  expect(provider.capability({ threadId: "thread", expectedTurnId: "turn-b" })).toEqual({ status: "unavailable", reason: "turn_changed" });
  expect(await provider.interrupt({ threadId: "thread", expectedTurnId: "turn-a" })).toEqual({ status: "interrupting" });
  expect(calls).toEqual([{ threadId: "thread", expectedTurnId: "turn-a" }]);

  current = null;
  result = "already_finished";
  expect(provider.capability({ threadId: "thread", expectedTurnId: "turn-a" })).toEqual({ status: "unavailable", reason: "not_owned" });
  expect(await provider.interrupt({ threadId: "thread", expectedTurnId: "turn-a" })).toEqual({ status: "already_finished" });
});

test("interrupt router falls through only before dispatch and pins the selected provider afterwards", async () => {
  let fallbackCalls = 0;
  const unverified: InterruptProvider = {
    id: "unverified",
    capability: () => ({ status: "unavailable", reason: "provider_unverified" }),
    async interrupt() { return { status: "provider_unverified" }; },
  };
  const verified: InterruptProvider = {
    id: "verified",
    capability: () => ({ status: "available" }),
    async interrupt() { fallbackCalls++; return { status: "interrupting" }; },
  };
  const router = new InterruptRouter([unverified, verified]);
  expect(router.capability({ threadId: "thread", expectedTurnId: "turn" })).toEqual({ status: "available" });
  expect(await router.interrupt({ threadId: "thread", expectedTurnId: "turn" })).toEqual({ status: "interrupting" });
  expect(fallbackCalls).toBe(1);

  fallbackCalls = 0;
  const failedAfterSelection: InterruptProvider = {
    id: "failed",
    capability: () => ({ status: "available" }),
    async interrupt() { return { status: "provider_unavailable" }; },
  };
  const pinned = new InterruptRouter([failedAfterSelection, verified]);
  expect(await pinned.interrupt({ threadId: "thread", expectedTurnId: "turn" })).toEqual({ status: "provider_unavailable" });
  expect(fallbackCalls).toBe(0);
});

test("production-style owned-only router fails closed for non-owned external turns", async () => {
  let interruptCalls = 0;
  const router = new InterruptRouter([
    new OwnedAppServerInterruptProvider({
      ownedTurn: () => null,
      async interruptOwnedTurn() { interruptCalls++; return { status: "not_owned" as const }; },
    } as any),
  ]);
  const target = { threadId: "external-thread", expectedTurnId: "external-turn" };
  expect(router.capability(target)).toEqual({ status: "unavailable", reason: "provider_unverified" });
  expect(await router.interrupt(target)).toEqual({ status: "provider_unverified" });
  expect(interruptCalls).toBe(1);
});

test("router never retargets after exact-turn mismatch", async () => {
  let laterCalls = 0;
  const changed: InterruptProvider = {
    id: "changed",
    capability: () => ({ status: "unavailable", reason: "turn_changed" }),
    async interrupt() { return { status: "turn_changed" }; },
  };
  const later: InterruptProvider = {
    id: "later",
    capability: () => ({ status: "available" }),
    async interrupt() { laterCalls++; return { status: "interrupting" }; },
  };
  const router = new InterruptRouter([changed, later]);
  expect(router.capability({ threadId: "thread", expectedTurnId: "old" })).toEqual({ status: "unavailable", reason: "turn_changed" });
  expect(await router.interrupt({ threadId: "thread", expectedTurnId: "old" })).toEqual({ status: "turn_changed" });
  expect(laterCalls).toBe(0);
});

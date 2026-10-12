import type { CodexAppServerClient } from "./codex-app-server-client.ts";

export interface InterruptTarget {
  threadId: string;
  expectedTurnId: string;
}

export type InterruptCapability =
  | { status: "available" }
  | { status: "interrupting" }
  | { status: "unavailable"; reason: "not_owned" | "turn_unknown" | "provider_unavailable" | "provider_unverified" | "turn_changed" };

export type InterruptResult =
  | { status: "interrupting" }
  | { status: "turn_changed" }
  | { status: "already_finished" }
  | { status: "provider_unavailable" }
  | { status: "provider_unverified" };

export interface InterruptProvider {
  readonly id: string;
  capability(target: InterruptTarget): InterruptCapability;
  interrupt(target: InterruptTarget): Promise<InterruptResult>;
}

/** First verified provider: reuse the exact AppServerSession that owns the active turn. */
export class OwnedAppServerInterruptProvider implements InterruptProvider {
  readonly id = "owned_app_server";

  constructor(private readonly client: Pick<CodexAppServerClient, "ownedTurn" | "interruptOwnedTurn">) {}

  capability(target: InterruptTarget): InterruptCapability {
    const owned = this.client.ownedTurn(target.threadId);
    if (!owned || owned.terminalObserved) return { status: "unavailable", reason: "not_owned" };
    if (!owned.turnId) return { status: "unavailable", reason: "turn_unknown" };
    if (owned.turnId !== target.expectedTurnId) return { status: "unavailable", reason: "turn_changed" };
    return owned.state === "interrupting" ? { status: "interrupting" } : { status: "available" };
  }

  async interrupt(target: InterruptTarget): Promise<InterruptResult> {
    try {
      const result = await this.client.interruptOwnedTurn(target);
      if (result.status === "interrupting" || result.status === "already_finished" || result.status === "turn_changed") return result;
      return { status: "provider_unverified" };
    } catch {
      return { status: "provider_unavailable" };
    }
  }
}

/**
 * Select one provider once for each exact-turn request. A selected provider is never
 * replaced by a fallback after dispatch, so failures cannot accidentally retarget a turn.
 */
export class InterruptRouter {
  constructor(private readonly providers: readonly InterruptProvider[]) {}

  capability(target: InterruptTarget): InterruptCapability {
    let sawUnavailable = false;
    for (const provider of this.providers) {
      const capability = provider.capability(target);
      if (capability.status === "available" || capability.status === "interrupting") return capability;
      if (capability.reason === "turn_unknown" || capability.reason === "turn_changed") return capability;
      if (capability.reason === "provider_unavailable") sawUnavailable = true;
    }
    return { status: "unavailable", reason: sawUnavailable ? "provider_unavailable" : "provider_unverified" };
  }

  async interrupt(target: InterruptTarget): Promise<InterruptResult> {
    for (const provider of this.providers) {
      const result = await provider.interrupt(target);
      // "provider_unverified" means this provider had no exact ownership/control evidence and sent no RPC.
      if (result.status === "provider_unverified") continue;
      // Any other result pins the request to this provider; never fallback after an attempted dispatch.
      return result;
    }
    return { status: "provider_unverified" };
  }
}

import { statSync } from "node:fs";
import type { Logger } from "../../logger.ts";
import type { ContinuationQueue } from "../../state/continuation-queue.ts";
import type { ApprovalCoordinator } from "../approval-coordinator.ts";
import { permissionOutput, stopContinuationOutput, type CodexHookEvent, type HookTransportRequest } from "../hook-types.ts";
import { SessionStateStore } from "../session-state.ts";

export interface HookHandleResult {
  output: Record<string, unknown> | null;
  onDelivered?: () => void;
  onDeliveryFailed?: () => void;
}

export interface CodexHookProviderOptions {
  activeSessionTtlMs: number;
  maxTransportAgeMs?: number;
  requireFreshTranscript?: boolean;
}

export class CodexHookProvider {
  private readonly maxTransportAgeMs: number;

  constructor(
    private readonly sessions: SessionStateStore,
    private readonly queue: ContinuationQueue,
    private readonly approvals: ApprovalCoordinator,
    private readonly logger: Logger,
    private readonly options: CodexHookProviderOptions,
  ) {
    this.maxTransportAgeMs = options.maxTransportAgeMs ?? 30_000;
  }

  async handle(request: HookTransportRequest): Promise<HookHandleResult> {
    const event = request.event;
    this.validateEnvelope(request);

    const previous = this.sessions.getById(event.session_id);
    const { eventHash, duplicate } = this.sessions.recordEvent(event);

    if (Date.now() - request.sentAt > this.maxTransportAgeMs) {
      this.sessions.markEventStale(eventHash);
      this.logger.warn("hook_transport_stale", { event: event.hook_event_name, sessionId: event.session_id });
      return { output: null };
    }

    switch (event.hook_event_name) {
      case "PermissionRequest":
        return this.handlePermission(eventHash, event, duplicate, previous);
      case "Stop":
        return this.handleStop(eventHash, event, duplicate, previous);
      case "UserPromptSubmit":
        if (!duplicate && this.isTranscriptFresh(event)) this.sessions.observeEvent(event);
        else if (!duplicate) this.sessions.markEventStale(eventHash);
        return { output: null };
      case "SessionStart":
        if (!duplicate) this.sessions.observeEvent(event);
        return { output: null };
      case "PreToolUse":
      case "PostToolUse":
      case "PreCompact":
      case "PostCompact":
        if (!duplicate && this.isFreshSameTurn(previous, event)) this.sessions.observeEvent(event);
        else if (!duplicate) this.sessions.markEventStale(eventHash);
        return { output: null };
      case "Interrupt":
        if (!duplicate && this.isFreshSameTurn(previous, event)) this.sessions.observeEvent(event);
        else if (!duplicate) this.sessions.markEventStale(eventHash);
        return { output: null };
      case "SessionEnd":
        if (!duplicate && previous) this.sessions.observeEvent(event);
        return { output: null };
      default:
        this.logger.debug("hook_event_observed", { event: event.hook_event_name, sessionId: event.session_id });
        return { output: null };
    }
  }

  private async handlePermission(
    eventHash: string,
    event: CodexHookEvent,
    duplicate: boolean,
    previous: ReturnType<SessionStateStore["getById"]>,
  ): Promise<HookHandleResult> {
    if (duplicate || !event.turn_id || !this.isFreshSameTurn(previous, event)) {
      this.sessions.markEventStale(eventHash);
      this.logger.warn("permission_hook_replay_suspected", {
        duplicate,
        sessionId: event.session_id,
        turnId: event.turn_id ?? null,
        previousTurnId: previous?.turnId ?? null,
        previousState: previous?.activityState ?? null,
      });
      return { output: null };
    }

    this.sessions.observeEvent(event);
    const resolution = await this.approvals.request(eventHash, event);
    if (!resolution) return { output: null };
    return {
      output: permissionOutput(resolution.decision),
      onDelivered: () => this.approvals.markDelivered(resolution.approvalId),
      onDeliveryFailed: () => this.approvals.markDeliveryFailed(resolution.approvalId),
    };
  }

  private async handleStop(
    eventHash: string,
    event: CodexHookEvent,
    duplicate: boolean,
    previous: ReturnType<SessionStateStore["getById"]>,
  ): Promise<HookHandleResult> {
    if (duplicate || !event.turn_id || event.stop_hook_active === true || !this.isFreshSameTurn(previous, event)) {
      if (duplicate || !this.isFreshSameTurn(previous, event)) this.sessions.markEventStale(eventHash);
      this.logger.debug("stop_hook_no_continuation", {
        duplicate,
        stopHookActive: event.stop_hook_active ?? false,
        sessionId: event.session_id,
        turnId: event.turn_id ?? null,
      });
      return { output: null };
    }

    this.sessions.observeEvent(event);
    const item = this.queue.claimNext(event.session_id, event.turn_id);
    if (!item) return { output: null };

    this.logger.info("continuation_claimed", {
      queueId: item.id,
      sessionId: event.session_id,
      turnId: event.turn_id,
    });

    return {
      output: stopContinuationOutput(item.text),
      onDelivered: () => {
        this.queue.markConsumed(item.id);
        this.sessions.setActivity(event.session_id, "active", event.turn_id);
        this.logger.info("continuation_delivered", { queueId: item.id, sessionId: event.session_id });
      },
      onDeliveryFailed: () => {
        this.queue.releaseClaim(item.id);
        this.logger.warn("continuation_delivery_failed", { queueId: item.id, sessionId: event.session_id });
      },
    };
  }

  private isFreshSameTurn(previous: ReturnType<SessionStateStore["getById"]>, event: CodexHookEvent): boolean {
    if (!previous || !event.turn_id) return false;
    if (previous.activityState !== "active" || previous.turnId !== event.turn_id) return false;
    if (Date.now() - previous.lastSeenAt > this.options.activeSessionTtlMs) return false;
    if (this.options.requireFreshTranscript === false) return true;

    return this.isTranscriptFresh(event, previous.transcriptPath);
  }

  private isTranscriptFresh(event: CodexHookEvent, expectedPath?: string | null): boolean {
    if (this.options.requireFreshTranscript === false) return true;
    const transcriptPath = typeof event.transcript_path === "string" ? event.transcript_path : null;
    if (!transcriptPath) return false;
    if (expectedPath && expectedPath !== transcriptPath) return false;
    try {
      const stat = statSync(transcriptPath);
      return stat.isFile() && Date.now() - stat.mtimeMs <= this.options.activeSessionTtlMs;
    } catch {
      return false;
    }
  }

  private validateEnvelope(request: HookTransportRequest): void {
    if (request.protocolVersion !== 1) throw new Error(`Unsupported hook transport protocol: ${request.protocolVersion}`);
    if (!request.invocationId || !Number.isFinite(request.sentAt)) throw new Error("Invalid hook transport envelope");
    if (!request.event || typeof request.event !== "object") throw new Error("Missing hook event");
    if (!request.event.session_id || !request.event.hook_event_name) throw new Error("Hook event missing session_id/hook_event_name");
  }
}

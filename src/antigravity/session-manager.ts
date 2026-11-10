import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WebStore } from "../web/store.ts";
import type { CreateRequest, SourceResult } from "../web/sources/types.ts";
import type { AntigravityApprovalBridge } from "./approval-bridge.ts";
import type { AntigravityCapabilityGate } from "./capabilities.ts";
import { AcpClient, type AcpClientCallbacks } from "./client.ts";
import type { AntigravityDesktopReader } from "./desktop-reader.ts";
import type { AntigravityModelCatalog } from "./model-catalog.ts";
import { isValidAntigravitySessionId, type AllowedAntigravityProject } from "./policy.ts";
import { applyLiveSessionUpdate, collectReplayUpdate, type ActiveTurnCollector, type ReplayCollector, type WebExecutionControl } from "./projection.ts";
import type { AcpConfigOption, AcpSessionUpdateParams } from "./protocol.ts";
import type { AntigravityExecutionRecord, AntigravitySessionRecord, AntigravityStore } from "./store.ts";

export type AcpClientFactory = (generation: number, cwd: string, callbacks: AcpClientCallbacks, appDataDir?: string | undefined) => AcpClient;

interface SessionActor {
  sessionId: string; cwd: string; client: AcpClient | null; generation: number;
  retireWorkerAfterTurn: boolean; activeTurn: ActiveTurnCollector | null; replaying: ReplayCollector | null;
}

/** Owns SeaBridge-managed Antigravity ACP sessions, P4 Desktop session adoption, single-turn serialization, and exact interruption. */
export class AntigravitySessionManager {
  private nextGeneration = 1;
  private readonly actors = new Map<string, SessionActor>();

  constructor(private readonly deps: {
    store: AntigravityStore; webStore?: WebStore | undefined; approvalBridge: AntigravityApprovalBridge;
    capabilityGate: AntigravityCapabilityGate; modelCatalog: AntigravityModelCatalog;
    cliPath: string; geminiDir?: string | undefined; appDataDir?: string | undefined;
    desktopReader?: AntigravityDesktopReader | undefined; desktopAppDataDir?: string | undefined;
    approvalPolicy?: "auto" | "ask" | undefined; externalSessionsEnabled?: boolean | undefined;
    getAllowedProjects: () => readonly AllowedAntigravityProject[]; clientFactory?: AcpClientFactory | undefined;
    onSessionEvent?: ((sessionId: string) => void) | undefined; onDesktopTurnSettled?: ((sessionId: string) => void) | undefined;
  }) {}

  /** Synchronously execute `session/new` + model/effort setup, then dispatch `session/prompt` asynchronously. */
  async create(input: CreateRequest): Promise<SourceResult> {
    const project = this.deps.getAllowedProjects().find((p) => p.id === input.projectId);
    if (!project) return { state: "failed", sessionId: null, errorCode: "invalid_project" };
    let resolvedModel: { baseModelId: string; reasoningEffort: string | null; variantId: string } | null = null;
    if (input.modelId) {
      resolvedModel = await this.deps.modelCatalog.resolveSelection(input.modelId, input.reasoningEffort);
      if (!resolvedModel) return { state: "failed", sessionId: null, errorCode: "invalid_model" };
    }
    const generation = this.nextGeneration++;
    let boundSessionId: string | null = null;
    const client = this.spawnClient(generation, project.rootPath, () => boundSessionId, this.deps.appDataDir);
    try {
      const capSnap = this.deps.capabilityGate.recordHandshake(await client.initialize());
      if (!capSnap.protocolCompatible) { client.close(); return { state: "failed", sessionId: null, errorCode: "protocol_incompatible" }; }
      const setupRes = await client.sessionNew(project.rootPath);
      const sessionId = setupRes.sessionId;
      if (!isValidAntigravitySessionId(sessionId)) { client.close(); return { state: "failed", sessionId: null, errorCode: "invalid_session_id" }; }
      boundSessionId = sessionId;

      const effectiveModelId = setupRes.configOptions?.find((c) => c.id === "model")?.currentValue ?? setupRes.models?.currentModelId ?? resolvedModel?.baseModelId ?? null;
      const effectiveEffort = setupRes.configOptions?.find((c) => c.id === "thought_level")?.currentValue ?? resolvedModel?.reasoningEffort ?? null;
      const effectiveMode = setupRes.configOptions?.find((c) => c.id === "mode")?.currentValue ?? "default";
      const now = Date.now();
      const sessionRecord: AntigravitySessionRecord = {
        sessionId, nativeSessionId: sessionId, sessionOrigin: "sea_bridge", projectId: project.id, cwd: project.rootPath,
        title: input.prompt.trim().slice(0, 80) || sessionId, modelId: effectiveModelId, reasoningEffort: effectiveEffort,
        modeId: effectiveMode, status: "running", completeHistory: true, snapshotGeneration: 1,
        lastExecutionId: null, lastExecutionEpoch: 0, createdAt: now, updatedAt: now,
      };
      this.deps.store.upsertSession(sessionRecord);
      input.onSessionKnown(sessionId);
      if (resolvedModel) {
        const applied = await this.applyModelConfig(client, sessionId, resolvedModel.baseModelId, resolvedModel.reasoningEffort);
        Object.assign(sessionRecord, { modelId: applied.modelId, reasoningEffort: applied.reasoningEffort, updatedAt: Date.now() });
        this.deps.store.upsertSession(sessionRecord);
      }
      const actor: SessionActor = { sessionId, cwd: project.rootPath, client, generation, retireWorkerAfterTurn: false, activeTurn: null, replaying: null };
      this.actors.set(sessionId, actor);
      return { state: "queued", sessionId, turnId: this.startAsyncPromptTurn(actor, sessionRecord, input.operationId, input.prompt) };
    } catch {
      client.close();
      if (boundSessionId) {
        const existing = this.deps.store.getSession(boundSessionId);
        if (existing) this.deps.store.upsertSession({ ...existing, status: "failed", lastError: "create_setup_failed", updatedAt: Date.now() });
        return { state: "failed", sessionId: boundSessionId, errorCode: "create_setup_failed" };
      }
      return { state: "delivery_unknown", sessionId: null, errorCode: "create_handshake_unknown" };
    }
  }

  /** Send a follow-up prompt to a managed or P4-adopted Desktop session; rejects concurrent turns with `session_busy`. */
  async send(sessionId: string, operationId: string, prompt: string): Promise<SourceResult> {
    const resolved = this.resolveOrAdoptSession(sessionId);
    if (!resolved.session) return { state: "failed", sessionId, errorCode: resolved.errorCode ?? "session_not_found" };
    const session = resolved.session;
    const existingActor = this.actors.get(sessionId);
    if (existingActor?.activeTurn || existingActor?.replaying || session.status === "running" || session.status === "cancelling") {
      return { state: "failed", sessionId, errorCode: "session_busy" };
    }
    try {
      const actor = await this.ensureIdleActor(session);
      if (session.sessionOrigin === "desktop") actor.retireWorkerAfterTurn = true;
      const executionId = this.startAsyncPromptTurn(actor, session, operationId, prompt);
      return { state: "queued", sessionId, turnId: executionId };
    } catch {
      return { state: "failed", sessionId, errorCode: "session_resume_failed" };
    }
  }

  /** Interrupt the exact active execution (`expectedExecutionId + expectedEpoch`) and retire the worker after settlement. */
  async interruptExecution(sessionId: string, expectedExecutionId: string, expectedEpoch: number): Promise<{ status: "interrupting" }> {
    const actor = this.actors.get(sessionId);
    const active = actor?.activeTurn;
    if (!actor || !active) {
      const lastExec = this.deps.store.getExecution(expectedExecutionId);
      if (lastExec && lastExec.sessionId === sessionId && ["completed", "cancelled", "incomplete", "failed"].includes(lastExec.status)) {
        throw new Error("interrupt_already_finished");
      }
      throw new Error("active_execution_changed");
    }
    if (active.executionId !== expectedExecutionId || active.epoch !== expectedEpoch) throw new Error("active_execution_changed");
    active.cancelRequested = true;
    actor.retireWorkerAfterTurn = true;
    const now = Date.now();
    const execRecord = this.deps.store.getExecution(active.executionId);
    if (execRecord) this.deps.store.upsertExecution({ ...execRecord, status: "cancelling", updatedAt: now });
    const sessRecord = this.deps.store.getSession(sessionId);
    if (sessRecord) this.deps.store.upsertSession({ ...sessRecord, status: "cancelling", updatedAt: now });

    this.deps.approvalBridge.cancelPendingForSession(sessionId, "user_interrupt", now);
    if (actor.client) await actor.client.cancel(sessionId).catch(() => {});
    this.deps.onSessionEvent?.(sessionId);
    return { status: "interrupting" };
  }

  /** Update a managed or P4-adopted Desktop session's model and reasoning effort while idle. */
  async updateModel(sessionId: string, modelId: string, reasoningEffort?: string | null): Promise<{ status: "updated"; model: { id: string; displayName?: string }; reasoningEffort?: string }> {
    const resolvedSess = this.resolveOrAdoptSession(sessionId);
    if (!resolvedSess.session) throw new Error(resolvedSess.errorCode ?? "session_not_found");
    const session = resolvedSess.session;
    const actor = this.actors.get(sessionId);
    if (actor?.activeTurn || actor?.replaying || session.status === "running" || session.status === "cancelling") throw new Error("session_busy");
    const resolved = await this.deps.modelCatalog.resolveSelection(modelId, reasoningEffort);
    if (!resolved) throw new Error("invalid_model");
    if (actor?.client && !actor.client.identity().closed) await this.applyModelConfig(actor.client, sessionId, resolved.baseModelId, resolved.reasoningEffort);
    this.deps.store.upsertSession({ ...session, status: session.status === "unknown" ? "idle" : session.status, modelId: resolved.baseModelId, reasoningEffort: resolved.reasoningEffort, updatedAt: Date.now() });
    this.deps.onSessionEvent?.(sessionId);
    return { status: "updated", model: { id: resolved.baseModelId, displayName: resolved.displayName }, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) };
  }

  /** Explicitly reload a managed session via `session/load` and atomically swap its history snapshot. */
  async reloadSessionHistory(sessionId: string): Promise<boolean> {
    const session = this.deps.store.getSession(sessionId);
    if (!session) throw new Error("session_not_found");
    const existing = this.actors.get(sessionId);
    if (existing?.activeTurn || existing?.replaying) throw new Error("session_busy");
    const generation = this.nextGeneration++;
    const client = this.spawnClient(generation, session.cwd, () => sessionId, this.targetAppDataDir(session));
    const newSnapshotGen = session.snapshotGeneration + 1;
    const actor: SessionActor = {
      sessionId, cwd: session.cwd, client, generation, retireWorkerAfterTurn: false, activeTurn: null,
      replaying: { generation, newSnapshotGen, messages: [], seqCounter: 1, assistantMsgId: null, assistantText: "" },
    };
    this.actors.set(sessionId, actor);
    try {
      const caps = this.deps.capabilityGate.recordHandshake(await client.initialize());
      if (!caps.protocolCompatible || !caps.loadSupported) throw new Error("load_not_supported");
      await client.sessionLoad(sessionId, session.cwd);
      const replay = actor.replaying;
      actor.replaying = null;
      if (replay) this.deps.store.replaceReplaySnapshot(sessionId, newSnapshotGen, replay.messages, true, Date.now());
      return true;
    } catch {
      actor.replaying = null; client.close(); actor.client = null;
      const current = this.deps.store.getSession(sessionId);
      if (current) this.deps.store.upsertSession({ ...current, completeHistory: false, updatedAt: Date.now() });
      return false;
    }
  }

  /** Return execution control metadata for a managed session. */
  getExecutionControl(sessionId: string): WebExecutionControl {
    const active = this.actors.get(sessionId)?.activeTurn;
    if (!active) {
      const session = this.deps.store.getSession(sessionId);
      return {
        activeExecutionId: session?.status === "unknown" ? (session.lastExecutionId ?? null) : null,
        activeEpoch: session?.status === "unknown" ? (session.lastExecutionEpoch ?? null) : null,
        interrupt: { status: "unavailable", reason: "execution_unknown" },
      };
    }
    return {
      activeExecutionId: active.executionId, activeEpoch: active.epoch,
      interrupt: { status: active.cancelRequested ? "interrupting" : "available", scope: "exact_antigravity_execution" },
    };
  }

  /** Return whether the session currently has an in-flight turn or replay in memory. */
  hasActiveTurn(sessionId: string): boolean {
    const actor = this.actors.get(sessionId); return Boolean(actor?.activeTurn || actor?.replaying);
  }

  /** Wait up to `gracePeriodMs` for in-flight turns to settle, then close all owned worker processes. */
  async shutdown(gracePeriodMs = 0): Promise<void> {
    const deadline = Date.now() + Math.max(0, gracePeriodMs);
    while (Date.now() < deadline && Array.from(this.actors.values()).some((a) => a.activeTurn || a.replaying)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const now = Date.now();
    for (const [sessionId, actor] of this.actors.entries()) {
      this.deps.approvalBridge.cancelPendingForSession(sessionId, "service_shutdown", now);
      actor.client?.close(); actor.client = null;
    }
    this.actors.clear();
  }

  private resolveOrAdoptSession(sessionId: string): { session?: AntigravitySessionRecord; errorCode?: string } {
    const existing = this.deps.store.getSession(sessionId);
    if (existing) {
      if (existing.sessionOrigin === "desktop") {
        if (!this.deps.externalSessionsEnabled) return { errorCode: "desktop_session_read_only" };
        if (this.deps.desktopReader?.inspectExternalSession(sessionId).externallyRunning && !this.actors.get(sessionId)?.activeTurn) {
          return { errorCode: "session_busy" };
        }
      }
      return { session: existing };
    }
    if (!this.deps.desktopReader) return { errorCode: "session_not_found" };
    const ext = this.deps.desktopReader.inspectExternalSession(sessionId);
    if (!ext.found) return { errorCode: "session_not_found" };
    if (!this.deps.externalSessionsEnabled) return { errorCode: "desktop_session_read_only" };
    if (ext.externallyRunning) return { errorCode: "session_busy" };
    if (!ext.projectId || !ext.cwd) return { errorCode: "invalid_project" };
    const now = Date.now();
    const adopted: AntigravitySessionRecord = {
      sessionId, nativeSessionId: sessionId, sessionOrigin: "desktop",
      projectId: ext.projectId, cwd: ext.cwd, title: ext.title || sessionId,
      modelId: null, reasoningEffort: null, modeId: "default", status: "idle",
      completeHistory: true, snapshotGeneration: 1, lastExecutionId: null, lastExecutionEpoch: 0,
      createdAt: ext.updatedAt || now, updatedAt: ext.updatedAt || now,
    };
    this.deps.store.upsertSession(adopted);
    return { session: adopted };
  }

  private targetAppDataDir(session: AntigravitySessionRecord): string | undefined {
    return session.sessionOrigin === "desktop"
      ? (this.deps.desktopAppDataDir ? path.basename(this.deps.desktopAppDataDir) : "antigravity")
      : this.deps.appDataDir;
  }

  private async ensureIdleActor(session: AntigravitySessionRecord): Promise<SessionActor> {
    const existing = this.actors.get(session.sessionId);
    if (existing?.client && !existing.client.identity().closed && !existing.retireWorkerAfterTurn) return existing;
    existing?.client?.close();
    const generation = this.nextGeneration++;
    const client = this.spawnClient(generation, session.cwd, () => session.sessionId, this.targetAppDataDir(session));
    const caps = this.deps.capabilityGate.recordHandshake(await client.initialize());
    if (!caps.protocolCompatible) { client.close(); throw new Error("protocol_incompatible"); }
    if (caps.resumeSupported) await client.sessionResume(session.sessionId, session.cwd);
    else if (caps.loadSupported) await client.sessionLoad(session.sessionId, session.cwd);
    else { client.close(); throw new Error("resume_unavailable"); }
    if (session.modelId) await this.applyModelConfig(client, session.sessionId, session.modelId, session.reasoningEffort ?? null);
    const actor: SessionActor = {
      sessionId: session.sessionId, cwd: session.cwd, client, generation, retireWorkerAfterTurn: false, activeTurn: null, replaying: null,
    };
    this.actors.set(session.sessionId, actor);
    return actor;
  }

  private startAsyncPromptTurn(actor: SessionActor, session: AntigravitySessionRecord, operationId: string, promptText: string): string {
    const now = Date.now();
    const executionId = `agy-exec-${randomUUID()}`;
    const epoch = (session.lastExecutionEpoch ?? 0) + 1;
    let seqCounter = (this.deps.store.listMessages(session.sessionId, session.snapshotGeneration).at(-1)?.seq ?? 0) + 1;
    this.deps.store.upsertMessage({
      id: `${executionId}-user`, sessionId: session.sessionId, snapshotGeneration: session.snapshotGeneration,
      seq: seqCounter++, role: "user", kind: "user_prompt", text: promptText,
      toolCallId: null, toolName: null, toolStatus: null, replayed: false, createdAt: now,
    });
    const turnState: ActiveTurnCollector = {
      executionId, operationId, epoch, generation: actor.generation, accepted: false,
      cancelRequested: false, assistantMsgId: `${executionId}-assistant`, assistantText: "", seqCounter,
    };
    actor.activeTurn = turnState;
    const { rpcRequestId, promise } = actor.client!.prompt(session.sessionId, promptText);
    this.deps.store.upsertExecution({
      executionId, operationId, sessionId: session.sessionId, epoch, processGeneration: actor.generation,
      rpcRequestId, status: "starting", stopReason: null, errorCode: null, createdAt: now, updatedAt: now,
    });
    this.deps.store.upsertSession({
      ...session, status: "running", lastExecutionId: executionId, lastExecutionEpoch: epoch, lastError: null, updatedAt: now,
    });
    void promise.then(
      (res) => this.finishPromptTurn(actor, turnState, res.stopReason),
      (err) => this.failPromptTurn(actor, turnState, err instanceof Error ? err.message : String(err))
    );
    return executionId;
  }

  private markTurnAccepted(turn: ActiveTurnCollector): void {
    if (turn.accepted) return;
    turn.accepted = true;
    const now = Date.now();
    this.deps.webStore?.transitionQueuedOperation(turn.operationId, "accepted", now);
    const exec = this.deps.store.getExecution(turn.executionId);
    if (exec && exec.status === "starting") this.deps.store.upsertExecution({ ...exec, status: "running", updatedAt: now });
  }

  private finishPromptTurn(actor: SessionActor, turn: ActiveTurnCollector, stopReason: string): void {
    if (actor.activeTurn?.executionId !== turn.executionId) return;
    this.markTurnAccepted(turn);
    actor.activeTurn = null;
    const now = Date.now();
    const status = stopReason === "end_turn" ? "completed" : stopReason === "cancelled" || turn.cancelRequested ? "cancelled" : "incomplete";
    const exec = this.deps.store.getExecution(turn.executionId);
    if (exec) this.deps.store.upsertExecution({ ...exec, status, stopReason, updatedAt: now });
    const sess = this.deps.store.getSession(actor.sessionId);
    if (sess) this.deps.store.upsertSession({ ...sess, status: "idle", updatedAt: now });
    this.deps.approvalBridge.cancelPendingForSession(actor.sessionId, "turn_finished", now);
    if (actor.retireWorkerAfterTurn || status === "cancelled" || sess?.sessionOrigin === "desktop") {
      actor.retireWorkerAfterTurn = false;
      const client = actor.client; actor.client = null;
      if (client) { if (sess?.sessionOrigin === "desktop" && typeof client.closeSession === "function") void client.closeSession(actor.sessionId).catch(() => {}).finally(() => { client.close(); this.deps.onDesktopTurnSettled?.(actor.sessionId); }); else { client.close(); if (sess?.sessionOrigin === "desktop") this.deps.onDesktopTurnSettled?.(actor.sessionId); } }
    }
    this.deps.onSessionEvent?.(actor.sessionId);
  }

  private failPromptTurn(actor: SessionActor, turn: ActiveTurnCollector, errorMessage: string): void {
    if (actor.activeTurn?.executionId !== turn.executionId) return;
    actor.activeTurn = null;
    const now = Date.now();
    this.deps.approvalBridge.cancelPendingForSession(actor.sessionId, "turn_failed", now);
    const exec = this.deps.store.getExecution(turn.executionId);
    const sess = this.deps.store.getSession(actor.sessionId);
    if (turn.cancelRequested) {
      this.markTurnAccepted(turn);
      if (exec) this.deps.store.upsertExecution({ ...exec, status: "cancelled", stopReason: "cancelled", updatedAt: now });
      if (sess) this.deps.store.upsertSession({ ...sess, status: "idle", updatedAt: now });
    } else {
      if (!turn.accepted) this.deps.webStore?.transitionQueuedOperation(turn.operationId, "delivery_unknown", now, "worker_disconnected");
      if (exec) this.deps.store.upsertExecution({ ...exec, status: "unknown", errorCode: errorMessage, updatedAt: now });
      if (sess) {
        if (!turn.assistantText.trim()) {
          this.deps.store.upsertMessage({
            id: `${turn.executionId}-error`, sessionId: actor.sessionId, snapshotGeneration: sess.snapshotGeneration, seq: turn.seqCounter++,
            role: "system", kind: "error", text: `本轮执行连接已中断（${errorMessage}），请检查操作结果或继续发送消息。`,
            toolCallId: null, toolName: null, toolStatus: null, replayed: false, createdAt: now,
          });
        }
        this.deps.store.upsertSession({ ...sess, status: "unknown", lastError: errorMessage, updatedAt: now });
      }
    }
    actor.client?.close(); actor.client = null;
    if (sess?.sessionOrigin === "desktop") this.deps.onDesktopTurnSettled?.(actor.sessionId);
    this.deps.onSessionEvent?.(actor.sessionId);
  }

  private handleSessionUpdate(sessionId: string | null, update: AcpSessionUpdateParams, generation: number): void {
    const targetId = sessionId ?? update.sessionId;
    const actor = this.actors.get(targetId);
    if (!actor || actor.generation !== generation) return;
    if (actor.replaying) { collectReplayUpdate(targetId, actor.replaying, update); return; }
    const turn = actor.activeTurn;
    const sess = this.deps.store.getSession(targetId);
    if (!turn || !sess) return;
    const { acceptedEvidence, updated } = applyLiveSessionUpdate({ targetId, session: sess, turn, update, store: this.deps.store });
    if (acceptedEvidence) this.markTurnAccepted(turn);
    if (updated) this.deps.onSessionEvent?.(targetId);
  }

  private async applyModelConfig(client: AcpClient, sessionId: string, baseModelId: string, reasoningEffort: string | null) {
    const modelRes = await client.setConfigOption(sessionId, "model", baseModelId);
    let updatedOptions: AcpConfigOption[] = modelRes.configOptions;
    const hasThoughtOption = updatedOptions.some((c) => c.id === "thought_level");
    if (reasoningEffort && hasThoughtOption) {
      updatedOptions = (await client.setConfigOption(sessionId, "thought_level", reasoningEffort)).configOptions;
    }
    return {
      modelId: updatedOptions.find((c) => c.id === "model")?.currentValue ?? baseModelId,
      reasoningEffort: updatedOptions.find((c) => c.id === "thought_level")?.currentValue ?? (hasThoughtOption ? reasoningEffort : null),
    };
  }

  private spawnClient(generation: number, cwd: string, getSessionId: () => string | null, appDataDir = this.deps.appDataDir): AcpClient {
    const autoApprove = this.deps.approvalPolicy === "auto";
    const callbacks: AcpClientCallbacks = {
      onSessionUpdate: (update, gen) => this.handleSessionUpdate(getSessionId(), update, gen),
      onPermissionRequest: async (id, req, gen) => {
        const targetId = getSessionId() ?? req.sessionId;
        const actor = this.actors.get(targetId);
        if (!actor || actor.generation !== gen || !actor.activeTurn) return { outcome: { outcome: "cancelled" } };
        this.markTurnAccepted(actor.activeTurn);
        const allowOpt = autoApprove ? (req.options.find((o) => o.kind.startsWith("allow") || o.optionId === "allow") ?? req.options[0]) : undefined;
        if (allowOpt) return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
        const { promise } = this.deps.approvalBridge.requestPermission({
          sessionId: targetId, executionId: actor.activeTurn.executionId, processGeneration: gen, rpcRequestId: id, request: req,
        });
        this.deps.onSessionEvent?.(targetId);
        return await promise;
      },
    };
    if (this.deps.clientFactory) { const custom = this.deps.clientFactory(generation, cwd, callbacks, appDataDir); custom.start(); return custom; }
    const args = ["acp", ...(autoApprove ? ["--dangerously-skip-permissions"] : []), ...(this.deps.geminiDir ? [`--gemini-dir=${this.deps.geminiDir}`] : []), ...(appDataDir ? [`--app-data-dir=${appDataDir}`] : [])];
    const client = new AcpClient({ cliPath: this.deps.cliPath, args, cwd, processGeneration: generation }, callbacks);
    client.start(); return client;
  }
}

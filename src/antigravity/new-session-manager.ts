import { createHash } from "node:crypto";
import type { CatalogItem, CreateRequest, SourceResult } from "../web/sources/types.ts";
import type { AntigravityModelCatalog } from "./model-catalog.ts";
import type { AntigravityProjectRecord, AntigravityStore } from "./store.ts";
import type {
  AntigravityModelPreference,
  AntigravityTelegramStore,
  PendingAntigravityNewSessionPrompt,
} from "./telegram-store.ts";

export type AntigravityCreateOutcome =
  | {
      status: "accepted";
      sessionId: string;
      turnId: string | null;
      project: AntigravityProjectRecord;
      model: AntigravityModelPreference | null;
    }
  | {
      status: "duplicate";
      sessionId: string;
      turnId: string | null;
      project: AntigravityProjectRecord;
      model: AntigravityModelPreference | null;
    }
  | { status: "failed"; errorCode: string }
  | { status: "delivery_unknown"; errorCode: string; sessionId: string | null };

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function stableOperationId(updateId: number): string {
  return `tg-agy-new-${updateId}`;
}

/** Manages Telegram `/agy_new` project resolution, model+effort preferences, ForceReply prompts, and idempotent session creation. */
export class AntigravityNewSessionManager {
  constructor(
    private readonly deps: {
      store: AntigravityStore;
      tgStore: AntigravityTelegramStore;
      modelCatalog: AntigravityModelCatalog;
      sessionManager: {
        create(input: CreateRequest): Promise<SourceResult>;
      };
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** List all configured allowed Antigravity projects. */
  listProjects(): AntigravityProjectRecord[] {
    return this.deps.store.listProjects();
  }

  /** Find an allowed project by 1-based index, exact ID, or unique display name. */
  async findProject(query: string): Promise<AntigravityProjectRecord | null> {
    const projects = this.listProjects();
    const normalized = query.trim();
    const index = Number.parseInt(normalized, 10);
    if (Number.isSafeInteger(index) && index >= 1 && index <= projects.length && String(index) === normalized) {
      return projects[index - 1] ?? null;
    }
    const exactId = projects.find((p) => p.id === normalized);
    if (exactId) return exactId;
    const nameMatches = projects.filter((p) => p.name === normalized);
    return nameMatches.length === 1 ? nameMatches[0]! : null;
  }

  /** Look up an allowed project by exact ID. */
  getProjectById(projectId: string): AntigravityProjectRecord | null {
    return this.listProjects().find((p) => p.id === projectId) ?? null;
  }

  /** List aggregated model families and supported reasoning efforts from `AntigravityModelCatalog`. */
  async listModels(): Promise<CatalogItem[]> {
    return await this.deps.modelCatalog.listModels(this.now());
  }

  /** Read per-chat saved `(modelId, reasoningEffort)` preference. */
  getDefaultModel(chatId: string): AntigravityModelPreference | null {
    return this.deps.tgStore.getDefaultModel(chatId);
  }

  /** Save or clear per-chat `(modelId, reasoningEffort)` preference. */
  setDefaultModel(chatId: string, pref: AntigravityModelPreference | null): void {
    this.deps.tgStore.setDefaultModel(chatId, pref, this.now());
  }

  /** Validate the chat's saved model and reasoning effort against the current catalog. */
  async validateSavedModel(chatId: string): Promise<AntigravityModelPreference | null | "stale"> {
    const selected = this.getDefaultModel(chatId);
    if (!selected) return null;
    const resolved = await this.deps.modelCatalog.resolveSelection(
      selected.modelId,
      selected.reasoningEffort,
      this.now()
    );
    if (!resolved) return "stale";
    return {
      modelId: resolved.baseModelId,
      reasoningEffort: resolved.reasoningEffort,
    };
  }

  /** Record a pending ForceReply prompt for `/agy_new`. */
  createPendingPrompt(
    chatId: string,
    promptMessageId: number,
    project: { id: string; name: string },
    ttlMs = 10 * 60_000
  ): void {
    const now = this.now();
    this.deps.tgStore.createPendingNewSessionPrompt(
      {
        chatId,
        promptMessageId,
        projectId: project.id,
        projectName: project.name,
        expiresAt: now + ttlMs,
      },
      now
    );
  }

  /** Atomically consume a pending ForceReply prompt. */
  consumePendingPrompt(chatId: string, promptMessageId: number): PendingAntigravityNewSessionPrompt | null {
    return this.deps.tgStore.consumePendingNewSessionPrompt(chatId, promptMessageId, this.now());
  }

  /** Inspect the status of a `/agy_new` ForceReply prompt. */
  getPendingPromptStatus(chatId: string, promptMessageId: number): "pending" | "consumed" | "expired" | null {
    return this.deps.tgStore.getPendingNewSessionPromptStatus(chatId, promptMessageId, this.now());
  }

  /** Create a managed Antigravity session idempotently for a Telegram `update_id`. */
  async create(
    updateId: number,
    chatId: string,
    projectId: string,
    prompt: string
  ): Promise<AntigravityCreateOutcome> {
    const normalized = prompt.trim();
    if (!normalized || normalized.length > 8192) {
      return { status: "failed", errorCode: "validation_failed" };
    }

    const hash = promptHash(normalized);
    const prior = this.deps.tgStore.getCreation(updateId);
    if (prior) {
      if (prior.projectId !== projectId || prior.promptHash !== hash) {
        return { status: "failed", errorCode: "duplicate_payload_mismatch" };
      }
      const priorModel: AntigravityModelPreference | null = prior.modelId
        ? { modelId: prior.modelId, reasoningEffort: prior.reasoningEffort }
        : null;
      if ((prior.status === "accepted" || prior.status === "acknowledged") && prior.sessionId) {
        const project = this.getProjectById(prior.projectId) ?? {
          id: prior.projectId,
          name: prior.projectId,
          rootPath: "",
          policyVersion: "v1",
          updatedAt: 0,
        };
        return {
          status: prior.status === "acknowledged" ? "duplicate" : "accepted",
          sessionId: prior.sessionId,
          turnId: prior.turnId,
          project,
          model: priorModel,
        };
      }
      if (prior.status === "delivery_unknown" || prior.status === "dispatching") {
        return {
          status: "delivery_unknown",
          errorCode: prior.errorCode ?? "already_dispatching",
          sessionId: prior.sessionId,
        };
      }
      if (prior.status === "failed") {
        return { status: "failed", errorCode: prior.errorCode ?? "rejected" };
      }
    }

    const project = this.getProjectById(projectId);
    if (!project) return { status: "failed", errorCode: "project_missing" };

    let selection: AntigravityModelPreference | null;
    if (prior?.status === "received") {
      selection = prior.modelId ? { modelId: prior.modelId, reasoningEffort: prior.reasoningEffort } : null;
      if (selection) {
        const resolved = await this.deps.modelCatalog.resolveSelection(
          selection.modelId,
          selection.reasoningEffort,
          this.now()
        );
        if (!resolved) return { status: "failed", errorCode: "model_unavailable" };
      }
    } else {
      const saved = await this.validateSavedModel(chatId);
      if (saved === "stale") return { status: "failed", errorCode: "model_unavailable" };
      selection = saved;
      const claim = this.deps.tgStore.beginCreation(
        updateId,
        project.id,
        selection?.modelId ?? null,
        selection?.reasoningEffort ?? null,
        hash,
        this.now()
      );
      if (claim !== "new") {
        return { status: "delivery_unknown", errorCode: "creation_claim_race", sessionId: null };
      }
    }

    if (!this.deps.tgStore.transitionCreation(updateId, "received", "dispatching", {}, this.now())) {
      const row = this.deps.tgStore.getCreation(updateId);
      return {
        status: "delivery_unknown",
        errorCode: row?.errorCode ?? "creation_state_changed",
        sessionId: row?.sessionId ?? null,
      };
    }

    let created: SourceResult;
    try {
      created = await this.deps.sessionManager.create({
        operationId: stableOperationId(updateId),
        projectId: project.id,
        prompt: normalized,
        modelId: selection?.modelId ?? null,
        reasoningEffort: selection?.reasoningEffort ?? null,
        onSessionKnown: () => {},
      });
    } catch {
      this.deps.tgStore.transitionCreation(
        updateId,
        "dispatching",
        "delivery_unknown",
        { errorCode: "transport_lost_after_create_dispatch" },
        this.now()
      );
      return {
        status: "delivery_unknown",
        errorCode: "transport_lost_after_create_dispatch",
        sessionId: null,
      };
    }

    if (created.state === "failed" || !created.sessionId) {
      const code = created.errorCode ?? "create_failed";
      this.deps.tgStore.transitionCreation(updateId, "dispatching", "failed", { errorCode: code }, this.now());
      return { status: "failed", errorCode: code };
    }
    if (created.state === "delivery_unknown") {
      const code = created.errorCode ?? "delivery_unknown";
      this.deps.tgStore.transitionCreation(
        updateId,
        "dispatching",
        "delivery_unknown",
        { sessionId: created.sessionId, turnId: created.turnId ?? null, errorCode: code },
        this.now()
      );
      return { status: "delivery_unknown", errorCode: code, sessionId: created.sessionId };
    }

    if (
      !this.deps.tgStore.transitionCreation(
        updateId,
        "dispatching",
        "accepted",
        { sessionId: created.sessionId, turnId: created.turnId ?? null },
        this.now()
      )
    ) {
      return {
        status: "delivery_unknown",
        errorCode: "creation_accept_commit_failed",
        sessionId: created.sessionId,
      };
    }

    return {
      status: "accepted",
      sessionId: created.sessionId,
      turnId: created.turnId ?? null,
      project,
      model: selection,
    };
  }

  /** Atomically link the Telegram creation receipt message and mark creation acknowledged. */
  acknowledge(updateId: number, chatId: string, messageId: number, sessionId: string): boolean {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ type: "agy.session.created", updateId, chatId, messageId, sessionId }))
      .digest("hex");
    return this.deps.tgStore.acknowledgeCreation(updateId, chatId, messageId, sessionId, fingerprint, this.now());
  }
}

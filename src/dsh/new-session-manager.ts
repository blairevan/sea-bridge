import { createHash } from "node:crypto";
import type { DshBridgeStore, PendingDshNewSessionPrompt } from "../state/dsh-bridge-store.ts";
import type {
  DshModelCatalog,
  DshModelSelection,
  DshProject,
} from "./types.ts";
import type { DshWebHostClient } from "./web-host-client.ts";

type WriteHost = Pick<
  DshWebHostClient,
  "health" | "listProjects" | "listModels" | "createSession" | "selectModel" | "submitPrompt"
>;

export interface DshModelChoice {
  provider: string;
  providerName: string;
  model: string;
  name: string;
}

export type DshCreateOutcome =
  | { status: "accepted"; sessionId: string; project: DshProject; model: DshModelSelection | null }
  | { status: "duplicate"; sessionId: string; project: DshProject; model: DshModelSelection | null }
  | { status: "failed"; errorCode: string }
  | { status: "delivery_unknown"; errorCode: string; sessionId: string | null };

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function stableSessionId(chatId: string, updateId: number): string {
  const suffix = createHash("sha256")
    .update(JSON.stringify({ chatId, updateId }))
    .digest("hex")
    .slice(0, 24);
  return `session-sea-bridge-${suffix}`;
}

function stablePromptRequestId(updateId: number): string {
  return `sea-bridge-new-${updateId}`;
}

function encodeSelection(selection: DshModelSelection | null): string | null {
  return selection ? JSON.stringify(selection) : null;
}

function decodeSelection(raw: string | null): DshModelSelection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.provider !== "string" || typeof row.model !== "string") return null;
    return {
      provider: row.provider,
      model: row.model,
      ...(typeof row.reasoningEffort === "string" ? { reasoningEffort: row.reasoningEffort } : {}),
    };
  } catch {
    return null;
  }
}

function flattenModels(catalog: DshModelCatalog): DshModelChoice[] {
  return catalog.groups.flatMap((group) =>
    group.models.map((model) => ({
      provider: group.id,
      providerName: group.name,
      model: model.id,
      name: model.name,
    })),
  );
}

function selectionExists(catalog: DshModelCatalog, selection: DshModelSelection): boolean {
  return catalog.groups.some((group) =>
    group.id === selection.provider && group.models.some((model) => model.id === selection.model),
  );
}

export class DshNewSessionManager {
  constructor(
    private readonly host: WriteHost,
    private readonly store: DshBridgeStore,
    private readonly now: () => number = Date.now,
  ) {}

  async listProjects(): Promise<DshProject[]> {
    await this.host.health();
    return this.host.listProjects();
  }

  async findProject(query: string): Promise<DshProject | null> {
    const projects = await this.listProjects();
    const normalized = query.trim();
    const index = Number.parseInt(normalized, 10);
    if (Number.isSafeInteger(index) && index >= 1 && index <= projects.length &&
      String(index) === normalized) {
      return projects[index - 1] ?? null;
    }
    const exactId = projects.find((project) => project.id === normalized);
    if (exactId) return exactId;
    const titleMatches = projects.filter((project) => project.title === normalized);
    return titleMatches.length === 1 ? titleMatches[0]! : null;
  }

  async getProjectById(projectId: string): Promise<DshProject | null> {
    return (await this.listProjects()).find((project) => project.id === projectId) ?? null;
  }

  async listModelChoices(): Promise<{ catalog: DshModelCatalog; choices: DshModelChoice[] }> {
    await this.host.health();
    const catalog = await this.host.listModels();
    return { catalog, choices: flattenModels(catalog) };
  }

  getDefaultModel(chatId: string): DshModelSelection | null {
    return decodeSelection(this.store.getDefaultModel(chatId));
  }

  setDefaultModel(chatId: string, selection: DshModelSelection | null): void {
    if (selection) this.store.setDefaultModel(chatId, encodeSelection(selection)!);
    else this.store.clearDefaultModel(chatId);
  }

  async validateSavedModel(chatId: string): Promise<DshModelSelection | null | "stale"> {
    const selected = this.getDefaultModel(chatId);
    if (!selected) return null;
    await this.host.health();
    const catalog = await this.host.listModels();
    return selectionExists(catalog, selected) ? selected : "stale";
  }

  createPendingPrompt(
    chatId: string,
    promptMessageId: number,
    projectId: string,
    ttlMs = 10 * 60_000,
  ): void {
    this.store.createPendingNewSessionPrompt({
      chatId,
      promptMessageId,
      projectId,
      expiresAt: this.now() + ttlMs,
    }, this.now());
  }

  consumePendingPrompt(
    chatId: string,
    promptMessageId: number,
  ): PendingDshNewSessionPrompt | null {
    return this.store.consumePendingNewSessionPrompt(chatId, promptMessageId, this.now());
  }

  getPendingPromptStatus(chatId: string, promptMessageId: number) {
    return this.store.getPendingNewSessionPromptStatus(chatId, promptMessageId);
  }

  async create(
    updateId: number,
    chatId: string,
    projectId: string,
    prompt: string,
  ): Promise<DshCreateOutcome> {
    const normalized = prompt.trim();
    if (!normalized || normalized.length > 8192) {
      return { status: "failed", errorCode: "validation_failed" };
    }

    const hash = promptHash(normalized);
    const prior = this.store.getCreation(updateId);
    if (prior) {
      if (prior.projectId !== projectId || prior.promptHash !== hash) {
        return { status: "failed", errorCode: "duplicate_payload_mismatch" };
      }
      const priorSelection = decodeSelection(prior.modelId);
      if (prior.modelId !== null && priorSelection === null) {
        return {
          status: "delivery_unknown",
          errorCode: "stored_model_selection_invalid",
          sessionId: prior.sessionId,
        };
      }
      if ((prior.status === "accepted" || prior.status === "acknowledged") && prior.sessionId) {
        let project: DshProject = { id: prior.projectId, title: prior.projectId, sessionCount: 0 };
        try {
          project = await this.getProjectById(prior.projectId) ?? project;
        } catch {
          // Acknowledgement recovery must not depend on fresh Host discovery.
        }
        return {
          status: prior.status === "acknowledged" ? "duplicate" : "accepted",
          sessionId: prior.sessionId,
          project,
          model: priorSelection,
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

    const project = await this.getProjectById(projectId);
    if (!project) return { status: "failed", errorCode: "project_missing" };

    let selection: DshModelSelection | null;
    let modelKey: string | null;
    if (prior?.status === "received") {
      selection = decodeSelection(prior.modelId);
      modelKey = prior.modelId;
      if (selection) {
        const catalog = await this.host.listModels();
        if (!selectionExists(catalog, selection)) {
          return { status: "failed", errorCode: "model_unavailable" };
        }
      }
    } else {
      const saved = await this.validateSavedModel(chatId);
      if (saved === "stale") return { status: "failed", errorCode: "model_unavailable" };
      selection = saved;
      modelKey = encodeSelection(selection);
      const claim = this.store.beginCreation(updateId, project.id, modelKey, hash, this.now());
      if (claim !== "new") {
        return { status: "delivery_unknown", errorCode: "creation_claim_race", sessionId: null };
      }
    }

    const existing = this.store.getCreation(updateId);
    if (!existing || existing.projectId !== project.id || existing.modelId !== modelKey ||
      existing.promptHash !== hash) {
      return { status: "delivery_unknown", errorCode: "creation_state_mismatch", sessionId: null };
    }

    if (!this.store.transitionCreation(updateId, "received", "dispatching", {}, this.now())) {
      const row = this.store.getCreation(updateId);
      return {
        status: "delivery_unknown",
        errorCode: row?.errorCode ?? "creation_state_changed",
        sessionId: row?.sessionId ?? null,
      };
    }

    const expectedSessionId = stableSessionId(chatId, updateId);
    let created;
    try {
      created = await this.host.createSession(project.id, expectedSessionId);
    } catch {
      this.store.transitionCreation(updateId, "dispatching", "delivery_unknown", {
        sessionId: expectedSessionId,
        errorCode: "transport_lost_after_create_dispatch",
      }, this.now());
      return {
        status: "delivery_unknown",
        errorCode: "transport_lost_after_create_dispatch",
        sessionId: expectedSessionId,
      };
    }
    if (created.status === "rejected") {
      this.store.transitionCreation(updateId, "dispatching", "failed", {
        errorCode: created.errorCode,
      }, this.now());
      return { status: "failed", errorCode: created.errorCode };
    }
    if (created.status === "delivery_unknown") {
      this.store.transitionCreation(updateId, "dispatching", "delivery_unknown", {
        sessionId: expectedSessionId,
        errorCode: created.errorCode,
      }, this.now());
      return { status: "delivery_unknown", errorCode: created.errorCode, sessionId: expectedSessionId };
    }

    const sessionId = created.sessionId;
    if (!this.store.registerCreatedSession(sessionId, updateId, this.now())) {
      const marker = this.store.getCreatedSession(sessionId);
      if (!marker || marker.creationUpdateId !== updateId) {
        this.store.transitionCreation(updateId, "dispatching", "delivery_unknown", {
          sessionId,
          errorCode: "created_session_marker_conflict",
        }, this.now());
        return {
          status: "delivery_unknown",
          errorCode: "created_session_marker_conflict",
          sessionId,
        };
      }
    }

    if (selection) {
      let modelResult;
      try {
        modelResult = await this.host.selectModel(sessionId, selection);
      } catch {
        this.store.transitionCreation(updateId, "dispatching", "delivery_unknown", {
          sessionId,
          errorCode: "transport_lost_after_model_dispatch",
        }, this.now());
        return {
          status: "delivery_unknown",
          errorCode: "transport_lost_after_model_dispatch",
          sessionId,
        };
      }
      if (modelResult.status !== "accepted") {
        this.store.transitionCreation(updateId, "dispatching", "delivery_unknown", {
          sessionId,
          errorCode: modelResult.errorCode,
        }, this.now());
        return { status: "delivery_unknown", errorCode: modelResult.errorCode, sessionId };
      }
    }

    let promptResult;
    try {
      promptResult = await this.host.submitPrompt(
        sessionId,
        stablePromptRequestId(updateId),
        normalized,
      );
    } catch {
      this.store.transitionCreation(updateId, "dispatching", "delivery_unknown", {
        sessionId,
        errorCode: "transport_lost_after_prompt_dispatch",
      }, this.now());
      return {
        status: "delivery_unknown",
        errorCode: "transport_lost_after_prompt_dispatch",
        sessionId,
      };
    }
    if (promptResult.status !== "accepted") {
      this.store.transitionCreation(updateId, "dispatching", "delivery_unknown", {
        sessionId,
        errorCode: promptResult.errorCode,
      }, this.now());
      return { status: "delivery_unknown", errorCode: promptResult.errorCode, sessionId };
    }

    if (!this.store.transitionCreation(updateId, "dispatching", "accepted", {
      sessionId,
    }, this.now())) {
      return { status: "delivery_unknown", errorCode: "creation_accept_commit_failed", sessionId };
    }
    return { status: "accepted", sessionId, project, model: selection };
  }

  acknowledge(
    updateId: number,
    chatId: string,
    messageId: number,
    sessionId: string,
  ): boolean {
    const fingerprint = createHash("sha256")
      .update(`dsh_created:${updateId}:${chatId}:${messageId}:${sessionId}`)
      .digest("hex");
    return this.store.acknowledgeCreation(
      updateId,
      chatId,
      messageId,
      sessionId,
      fingerprint,
      this.now(),
    );
  }
}

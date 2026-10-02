import type { CodexAppServerClient, ProjectItem, ModelOption } from "../../desktop/codex-app-server-client.ts";
import type { CodexThreadReader } from "../../desktop/codex-thread-store.ts";
import type { ProcessCodexQueueClient } from "../../desktop/codex-queue-client.ts";
import { readCodexTranscript } from "../codex-transcript.ts";
import { CatalogCache } from "./cache.ts";
import type { WebSource, WebSourceCapabilities, WebSession, CatalogItem, WebHistory, CreateRequest, SourceResult } from "./types.ts";

/** Narrow existing-source dependencies, with evidence injected at composition. */
export interface CodexSourceDependencies {
  threads: CodexThreadReader;
  appServer: Pick<CodexAppServerClient, "listProjects" | "listModels" | "startThreadAndTurn">;
  queue: Pick<ProcessCodexQueueClient, "queue">;
  sessionRoots: readonly string[];
  pathExists: (path: string) => boolean;
  queueUsable: boolean;
  pendingApproval: (id: string) => boolean;
}

/** Transport-neutral Codex adapter with a first-turn ownership gate. */
export class CodexWebSource implements WebSource {
  private readonly owners = new Set<string>();
  private readonly projectCache: CatalogCache<ProjectItem[]>;
  private readonly modelCache: CatalogCache<ModelOption[]>;
  private projectsReadable = false;
  private modelsReadable = false;
  private sessionsReadable = false;

  /** Reuse existing clients without changing Telegram preferences or mappings. */
  constructor(private readonly deps: CodexSourceDependencies) {
    this.projectCache = new CatalogCache(() => deps.appServer.listProjects());
    this.modelCache = new CatalogCache(() => deps.appServer.listModels());
  }

  /** Report independently proven discovery and configured execution capabilities. */
  capabilities(): WebSourceCapabilities {
    return { sessionsReadable: this.sessionsReadable, projectsReadable: this.projectsReadable, modelsReadable: this.modelsReadable,
      historyReadable: this.sessionsReadable, completeUserHistoryReadable: false, finalReplyReadable: this.sessionsReadable,
      createEnabled: this.projectsReadable && this.deps.queueUsable, sendEnabled: this.deps.queueUsable, approvalTransport: "telegram" };
  }

  /** List verified nonarchived threads without inventing project ownership. */
  async sessions(): Promise<WebSession[]> {
    try {
      const threads = this.deps.threads.listActive(); this.sessionsReadable = true;
      return threads.sort((a, b) => b.updatedAtMs - a.updatedAtMs).map((thread) => ({
        source: "codex", id: thread.id, title: thread.title, updatedAt: thread.updatedAtMs, projectId: null,
        state: this.deps.pendingApproval(thread.id) ? "waiting_external_approval" : "unknown",
        sendEnabled: this.deps.queueUsable && !this.owners.has(thread.id),
      }));
    } catch { this.sessionsReadable = false; throw new Error("source_unavailable"); }
  }

  /** Discover cached live projects, leaving missing-path entries unavailable. */
  async projects(): Promise<CatalogItem[]> {
    try { const projects = await this.projectCache.get(); this.projectsReadable = true;
      return projects.filter((project) => this.deps.pathExists(project.primaryRoot)).map((project) => ({ id: project.id, name: project.name }));
    } catch { this.projectsReadable = false; throw new Error("projects_unavailable"); }
  }

  /** Discover models rather than hardcoding an account's options. */
  async models(): Promise<CatalogItem[]> {
    try { const models = await this.modelCache.get(); this.modelsReadable = true;
      return models.map((model) => ({ id: model.id, name: model.displayName }));
    } catch { this.modelsReadable = false; throw new Error("models_unavailable"); }
  }

  /** Read only a stored thread's confined rollout, never a browser-supplied path. */
  async history(id: string, cursor: string | null, limit: number): Promise<WebHistory> {
    const thread = this.deps.threads.getThread?.(id);
    if (!thread) throw new Error("session_missing");
    return readCodexTranscript(thread.rolloutPath, this.deps.sessionRoots, cursor, limit);
  }

  /** Start a raw Web prompt with explicit request-local model selection. */
  async create(input: CreateRequest): Promise<SourceResult> {
    const project = (await this.projectCache.get()).find((item) => item.id === input.projectId);
    if (!project || !this.deps.pathExists(project.primaryRoot)) return { state: "failed", sessionId: null, errorCode: "project_missing" };
    if (input.modelId && !(await this.models()).some((model) => model.id === input.modelId)) return { state: "failed", sessionId: null, errorCode: "model_unavailable" };
    let known: string | null = null;
    try {
      const result = await this.deps.appServer.startThreadAndTurn({
        projectId: project.id, cwd: project.primaryRoot, prompt: input.prompt, ...(input.modelId ? { model: input.modelId } : {}),
        onThreadStarted: (id) => { known = id; this.owners.add(id); input.onSessionKnown(id); },
        onOwnershipReleased: (id) => { this.owners.delete(id); },
      });
      return { state: "accepted", sessionId: result.threadId, turnId: result.turnId };
    } catch { return { state: "delivery_unknown", sessionId: known, errorCode: "create_unconfirmed" }; }
  }

  /** Reject owned/missing threads before queueing; queue success proves only admission. */
  async send(id: string, _operationId: string, prompt: string): Promise<SourceResult> {
    if (!this.deps.queueUsable) return { state: "failed", sessionId: id, errorCode: "queue_unavailable" };
    if (this.owners.has(id)) return { state: "failed", sessionId: id, errorCode: "first_turn_owned" };
    if (!this.deps.threads.getThread?.(id)) return { state: "failed", sessionId: id, errorCode: "session_missing" };
    const result = await this.deps.queue.queue(id, prompt);
    return { state: result.status === "delivered" ? "queued" : result.status, sessionId: id, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
  }
}

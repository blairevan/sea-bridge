import { readCodexAttachment } from "../codex-attachment.ts";
import type { CodexAppServerClient, ProjectItem, ModelOption } from "../../desktop/codex-app-server-client.ts";
import type { CodexThreadReader } from "../../desktop/codex-thread-store.ts";
import type { ProcessCodexQueueClient } from "../../desktop/codex-queue-client.ts";
import type { CodexQueueSnapshot } from "../../desktop/codex-queue-store.ts";
import { readCodexTranscript, readCodexActivity, type CodexActivity } from "../codex-transcript.ts";
import { CatalogCache } from "./cache.ts";
import type { WebSource, WebSourceCapabilities, WebSession, CatalogItem, WebHistory, CreateRequest, SourceResult, ExecutionEvidence } from "./types.ts";

/** Narrow existing-source dependencies, with evidence injected at composition. */
export interface CodexSourceDependencies {
  openDesktop?: (id: string) => Promise<void>;
  threads: CodexThreadReader;
  appServer: Pick<CodexAppServerClient, "listProjects" | "listModels" | "startThreadAndTurn">;
  queue: Pick<ProcessCodexQueueClient, "queue">;
  sessionRoots: readonly string[];
  pathExists: (path: string) => boolean;
  queueUsable: boolean;
  pendingApproval: (id: string) => boolean;
  activity?: (id: string) => { state: "active" | "idle" | "unknown"; turnId: string | null } | null;
  registerCreatedThread?: (id: string) => void;
  readQueue?: (id: string) => CodexQueueSnapshot;
}

/** Transport-neutral Codex adapter with a first-turn ownership gate. */
export class CodexWebSource implements WebSource {
  private desktopOpening = false;
  private desktopOpenedAt = 0;
  private readonly owners = new Set<string>();
  private readonly nativeActivity = new Map<string, { activity: CodexActivity; readAt: number }>();
  private readonly projectCache: CatalogCache<ProjectItem[]>;
  private readonly modelCache: CatalogCache<ModelOption[]>;
  private projectsReadable = false;
  private modelsReadable = false;
  private sessionsReadable = false;
  private historyReadable = false;

  /** Reuse existing clients without changing Telegram preferences or mappings. */
  constructor(private readonly deps: CodexSourceDependencies) {
    this.projectCache = new CatalogCache(() => deps.appServer.listProjects());
    this.modelCache = new CatalogCache(() => deps.appServer.listModels());
  }

  /** Report independently proven discovery and configured execution capabilities. */
  capabilities(): WebSourceCapabilities {
    return { desktopOpenEnabled: Boolean(this.deps.openDesktop), sessionsReadable: this.sessionsReadable, projectsReadable: this.projectsReadable, modelsReadable: this.modelsReadable,
      historyReadable: this.historyReadable, completeUserHistoryReadable: false, finalReplyReadable: this.historyReadable,
      createEnabled: this.projectsReadable && this.deps.queueUsable, sendEnabled: this.deps.queueUsable, approvalTransport: "telegram" };
  }

  /** Open an existing active thread on explicit request; never queue or resume input here. */
  async openDesktop(id: string): Promise<void> {
    if (!this.deps.openDesktop) throw new Error("desktop_open_unavailable");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("invalid_session_id");
    if (!this.deps.threads.listActive().some((thread) => thread.id === id)) throw new Error("session_missing");
    if (this.owners.has(id)) throw new Error("first_turn_owned");
    if (this.desktopOpening || Date.now() - this.desktopOpenedAt < 5000) throw new Error("desktop_open_busy");
    this.desktopOpening = true;
    this.desktopOpenedAt = Date.now();
    try { await this.deps.openDesktop(id); }
    finally { this.desktopOpening = false; }
  }

  /** List verified nonarchived threads without inventing project ownership. */
  async sessions(): Promise<WebSession[]> {
    try {
      const threads = this.deps.threads.listActive(); this.sessionsReadable = true;
      return threads.sort((a, b) => b.updatedAtMs - a.updatedAtMs).map((thread) => {
        const approval = this.deps.pendingApproval(thread.id);
        const cached = this.nativeActivity.get(thread.id);
        const activity = cached && Date.now() - cached.readAt < 10_000 ? cached.activity : this.deps.activity?.(thread.id) ?? null;
        return {
          source: "codex" as const, id: thread.id, title: thread.title, updatedAt: thread.updatedAtMs, projectId: null,
          state: approval ? "waiting_external_approval" as const
            : this.owners.has(thread.id) || activity?.state === "active" ? "running" as const : activity?.state === "idle" ? "idle" as const : "unknown" as const,
          ...(cached?.activity.state === "active" && Date.now() - cached.readAt < 10_000 ? { startedAt: cached.activity.observedAt } : {}),
          sendEnabled: this.deps.queueUsable && !this.owners.has(thread.id),
        };
      });
    } catch { this.sessionsReadable = false; throw new Error("source_unavailable"); }
  }

  /** Report only observed runtime evidence; idle/absent evidence never proves completion. */
  async execution(id: string, turnId: string | null, submittedAt = 0): Promise<ExecutionEvidence> {
    if (this.deps.pendingApproval(id)) return { state: "waiting_external_approval", exact: false };
    if (this.owners.has(id)) return { state: "running", exact: false };
    const activity = this.deps.activity?.(id) ?? null;
    if (activity?.state === "active") return { state: "running", exact: Boolean(turnId && activity.turnId === turnId) };
    try {
      const thread = this.deps.threads.getThread?.(id);
      const observed = thread?.rolloutPath ? await readCodexActivity(thread.rolloutPath, this.deps.sessionRoots) : null;
      if (!observed || observed.observedAt < submittedAt) return { state: "unknown", exact: false };
      return { state: observed.state === "active" ? "running" : "session_ended", exact: Boolean(turnId && observed.turnId === turnId) };
    } catch { return { state: "unknown", exact: false }; }
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
    if (!thread) { this.historyReadable = false; throw new Error("session_missing"); }
    try {
      const [history, activity] = await Promise.all([
        readCodexTranscript(thread.rolloutPath, this.deps.sessionRoots, cursor, limit),
        readCodexActivity(thread.rolloutPath, this.deps.sessionRoots).catch(() => null),
      ]);
      if (activity) {
        this.nativeActivity.delete(id);
        this.nativeActivity.set(id, { activity, readAt: Date.now() });
        if (this.nativeActivity.size > 100) this.nativeActivity.delete(this.nativeActivity.keys().next().value ?? "");
      } else this.nativeActivity.delete(id);
      const sessionState: WebSession["state"] = this.deps.pendingApproval(id) ? "waiting_external_approval"
        : this.owners.has(id) || activity?.state === "active" ? "running" : activity?.state === "idle" ? "idle" : "unknown";
      this.historyReadable = true;
      const queue = this.deps.readQueue?.(id);
      const timing = activity?.state === "active" ? { activeTurnStartedAt: activity.observedAt } : {};
      return queue ? { ...history, ...timing, sessionState, ...(queue.available ? { queuedMessages: queue.messages } : {}), queueUnavailable: !queue.available } : { ...history, ...timing, sessionState };
    } catch (error) {
      this.historyReadable = false;
      throw error;
    }
  }

  /** Resolve images from native user records without accepting arbitrary browser paths. */
  async attachment(id: string, messageId: string, index: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const thread = this.deps.threads.getThread?.(id);
    if (!thread) throw new Error("attachment_missing");
    const history = await readCodexTranscript(thread.rolloutPath, this.deps.sessionRoots, null, 100);
    return readCodexAttachment(id, messageId, index, history);
  }

  /** Start a raw Web prompt with explicit request-local model selection. */
  async create(input: CreateRequest): Promise<SourceResult> {
    let projects: ProjectItem[];
    try { projects = await this.projectCache.get(); }
    catch { return { state: "failed", sessionId: null, errorCode: "projects_unavailable" }; }
    const project = projects.find((item) => item.id === input.projectId);
    if (!project || !this.deps.pathExists(project.primaryRoot)) return { state: "failed", sessionId: null, errorCode: "project_missing" };
    if (input.modelId) {
      let models: CatalogItem[];
      try { models = await this.models(); }
      catch { return { state: "failed", sessionId: null, errorCode: "models_unavailable" }; }
      if (!models.some((model) => model.id === input.modelId)) return { state: "failed", sessionId: null, errorCode: "model_unavailable" };
    }
    let known: string | null = null;
    try {
      const result = await this.deps.appServer.startThreadAndTurn({
        projectId: project.id, cwd: project.primaryRoot, prompt: input.prompt, ...(input.modelId ? { model: input.modelId } : {}),
        onThreadStarted: (id) => { known = id; this.owners.add(id); input.onSessionKnown(id); this.deps.registerCreatedThread?.(id); },
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
    const result = await this.deps.queue.queue(id, prompt, { source: "web" });
    return { state: result.status === "delivered" ? "queued" : result.status, sessionId: id, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
  }
}

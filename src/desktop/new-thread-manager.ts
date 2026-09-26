import { existsSync } from "node:fs";
import type {
  CodexAppServerClient,
  ModelOption,
  ProjectItem,
  StartedThread,
} from "./codex-app-server-client.ts";
import type { NewThreadStateStore, PendingNewThreadPrompt } from "../state/new-thread-state-store.ts";

const CACHE_TTL_MS = 60_000;
export const PENDING_NEW_THREAD_TTL_MS = 15 * 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface NewThreadManagerOptions {
  pathExists?: (path: string) => boolean;
  now?: () => number;
  onThreadStarted?: (threadId: string) => void;
}

export class NewThreadManager {
  private projectsCache: CacheEntry<ProjectItem[]> | null = null;
  private modelsCache: CacheEntry<ModelOption[]> | null = null;
  private readonly pathExists: (path: string) => boolean;
  private readonly now: () => number;
  private readonly onThreadStarted: (threadId: string) => void;

  constructor(
    private readonly appServer: Pick<CodexAppServerClient, "listProjects" | "listModels" | "startThreadAndTurn">,
    private readonly state: NewThreadStateStore,
    options: NewThreadManagerOptions = {},
  ) {
    this.pathExists = options.pathExists ?? existsSync;
    this.now = options.now ?? Date.now;
    this.onThreadStarted = options.onThreadStarted ?? (() => undefined);
  }

  async listProjects(forceRefresh = false): Promise<ProjectItem[]> {
    const now = this.now();
    if (!forceRefresh && this.projectsCache && this.projectsCache.expiresAt > now) {
      return this.projectsCache.value;
    }
    const projects = (await this.appServer.listProjects())
      .filter((project) => this.pathExists(project.primaryRoot))
      .map((project, index) => ({ ...project, index: index + 1 }));
    this.projectsCache = { value: projects, expiresAt: now + CACHE_TTL_MS };
    return projects;
  }

  async listModels(forceRefresh = false): Promise<ModelOption[]> {
    const now = this.now();
    if (!forceRefresh && this.modelsCache && this.modelsCache.expiresAt > now) {
      return this.modelsCache.value;
    }
    const models = await this.appServer.listModels();
    this.modelsCache = { value: models, expiresAt: now + CACHE_TTL_MS };
    return models;
  }

  async findProject(query: string, forceRefresh = false): Promise<ProjectItem | null> {
    const projects = await this.listProjects(forceRefresh);
    const trimmed = query.trim();
    if (/^\d+$/.test(trimmed)) {
      const index = Number.parseInt(trimmed, 10);
      return projects.find((project) => project.index === index) ?? null;
    }

    const matches = projects.filter((project) => project.name.toLowerCase() === trimmed.toLowerCase());
    return matches.length === 1 ? matches[0]! : null;
  }

  async getProjectById(projectId: string, forceRefresh = false): Promise<ProjectItem | null> {
    return (await this.listProjects(forceRefresh)).find((project) => project.id === projectId) ?? null;
  }

  getDefaultModel(chatId: string): string | null {
    return this.state.getDefaultModel(chatId);
  }

  setDefaultModel(chatId: string, model: string): void {
    this.state.setDefaultModel(chatId, model);
  }

  clearDefaultModel(chatId: string): void {
    this.state.clearDefaultModel(chatId);
  }

  createPendingPrompt(chatId: string, promptMessageId: number, project: ProjectItem): void {
    this.state.createPendingPrompt({
      chatId,
      promptMessageId,
      projectId: project.id,
      projectName: project.name,
      cwd: project.primaryRoot,
      expiresAt: this.now() + PENDING_NEW_THREAD_TTL_MS,
    });
  }

  getPendingPrompt(chatId: string, promptMessageId: number): PendingNewThreadPrompt | null {
    return this.state.getPendingPrompt(chatId, promptMessageId);
  }

  getPromptStatus(chatId: string, promptMessageId: number): "pending" | "consumed" | "expired" | null {
    return this.state.getPromptStatus(chatId, promptMessageId);
  }

  consumePendingPrompt(chatId: string, promptMessageId: number): PendingNewThreadPrompt | null {
    return this.state.consumePendingPrompt(chatId, promptMessageId, this.now());
  }

  cleanupExpired(): number {
    return this.state.cleanupExpired(this.now());
  }

  async startThread(
    chatId: string,
    project: Pick<ProjectItem, "id" | "primaryRoot">,
    prompt: string,
  ): Promise<StartedThread> {
    if (!this.pathExists(project.primaryRoot)) {
      throw new Error("project_path_missing");
    }
    const model = this.getDefaultModel(chatId);
    return this.appServer.startThreadAndTurn({
      projectId: project.id,
      cwd: project.primaryRoot,
      ...(model ? { model } : {}),
      prompt,
      onThreadStarted: this.onThreadStarted,
    });
  }

  async startPendingThread(chatId: string, pending: PendingNewThreadPrompt, prompt: string): Promise<StartedThread> {
    if (!this.pathExists(pending.cwd)) {
      throw new Error("project_path_missing");
    }
    const model = this.getDefaultModel(chatId);
    return this.appServer.startThreadAndTurn({
      projectId: pending.projectId,
      cwd: pending.cwd,
      ...(model ? { model } : {}),
      prompt,
      onThreadStarted: this.onThreadStarted,
    });
  }
}

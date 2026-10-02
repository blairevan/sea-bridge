import { createHash } from "node:crypto";
import type { DshWebHostClient } from "../../dsh/web-host-client.ts";
import type { DshModelCatalog, DshModelSelection, DshProject, DshWriteResult } from "../../dsh/types.ts";
import { CatalogCache } from "./cache.ts";
import type { WebSource, WebSourceCapabilities, WebSession, WebHistory, WebMessage, CatalogItem, CreateRequest, SourceResult, ExecutionEvidence } from "./types.ts";

type Host = Pick<DshWebHostClient, "health" | "listSessions" | "listProjects" | "listModels" | "followSnapshot" | "pageHistory" | "getTurnSummary" | "createSession" | "selectModel" | "submitPrompt">;

const DSH_PROMPT_MAX_CHARS = 8192;
const DSH_SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;

/** Stable Web-only namespace; no Telegram IDs or model preferences are used. */
function suffix(operationId: string): string { return createHash("sha256").update(operationId).digest("hex").slice(0, 24); }

/** Convert a proven Host write outcome without silently queueing busy sessions. */
function writeResult(result: DshWriteResult, sessionId: string): SourceResult {
  return result.status === "accepted" ? { state: "accepted", sessionId }
    : { state: result.status === "delivery_unknown" ? "delivery_unknown" : "failed", sessionId, errorCode: result.errorCode };
}

/** Existing dsh Host contract exposed to Web with explicit read/write gates. */
export class DshWebSource implements WebSource {
  private readonly projectCache: CatalogCache<DshProject[]>;
  private readonly modelCache: CatalogCache<DshModelCatalog>;
  private readonly summaryCache = new Map<string, WebMessage | null>();
  private transportHealthy = false;
  private sessionsReadable = false;
  private projectsReadable = false;
  private modelsReadable = false;
  private historyReadable = false;

  /** Reuse existing Host operations; never mutate Telegram-side state. */
  constructor(private readonly host: Host, private readonly reads: boolean, private readonly writes: boolean, private readonly snapshots: (id: string) => WebMessage[] = () => []) {
    this.projectCache = new CatalogCache(async () => {
      await this.probe();
      try { const projects = await host.listProjects(); this.projectsReadable = true; return projects; }
      catch { this.projectsReadable = false; throw new Error("projects_unavailable"); }
    });
    this.modelCache = new CatalogCache(async () => {
      await this.probe();
      try { const models = await host.listModels(); this.modelsReadable = true; return models; }
      catch { this.modelsReadable = false; throw new Error("models_unavailable"); }
    });
  }

  /** Report each proven Host capability independently. */
  capabilities(): WebSourceCapabilities {
    const enabled = this.reads;
    return { sessionsReadable: enabled && this.sessionsReadable, projectsReadable: enabled && this.projectsReadable,
      modelsReadable: enabled && this.modelsReadable, historyReadable: enabled && this.historyReadable,
      completeUserHistoryReadable: false, finalReplyReadable: enabled && this.historyReadable,
      createEnabled: enabled && this.writes && this.transportHealthy && this.projectsReadable,
      sendEnabled: enabled && this.writes && this.transportHealthy, approvalTransport: null };
  }

  /** List only Host-supplied session fields, never guessed project ownership. */
  async sessions(): Promise<WebSession[]> {
    this.requireRead();
    try {
      const sessions = await this.host.listSessions(); this.transportHealthy = true; this.sessionsReadable = true;
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt).map((session) => ({
        source: "dsh", id: session.sessionId, title: session.title ?? session.sessionId, updatedAt: session.updatedAt,
        projectId: null, state: session.running ? "running" : "unknown", sendEnabled: this.writes && !session.running,
      }));
    } catch { this.transportHealthy = false; this.sessionsReadable = false; throw new Error("source_unavailable"); }
  }

  /** dsh exposes session-level running evidence but not an exact Web operation turn id. */
  async execution(id: string, _turnId: string | null): Promise<ExecutionEvidence> {
    this.requireRead();
    try {
      const sessions = await this.host.listSessions(); this.transportHealthy = true; this.sessionsReadable = true;
      const session = sessions.find((item) => item.sessionId === id);
      return { state: session?.running ? "running" : "unknown", exact: false };
    } catch {
      this.transportHealthy = false; this.sessionsReadable = false;
      return { state: "unknown", exact: false };
    }
  }

  /** Reuse short-lived, coalesced verified project discovery. */
  async projects(): Promise<CatalogItem[]> {
    this.requireRead(); return (await this.projectCache.get()).map((project) => ({ id: project.id, name: project.title }));
  }

  /** Encode provider/model identity together without an ambiguous display-name lookup. */
  async models(): Promise<CatalogItem[]> {
    this.requireRead();
    return (await this.modelCache.get()).groups.flatMap((group) => group.models.map((model) => ({
      id: Buffer.from(JSON.stringify({ provider: group.id, model: model.id })).toString("base64url"), name: `${group.name} / ${model.name}`,
    })));
  }

  /** Page event metadata and read only exact-turn final replies; user history stays unavailable. */
  async history(id: string, cursor: string | null, limit: number): Promise<WebHistory> {
    this.requireRead();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^\d+:\d+$/.test(cursor))) throw new Error("history_cursor_invalid");
    this.historyReadable = false;
    const parts = cursor?.split(":").map(Number);
    const through = parts?.[0] ?? (await this.host.followSnapshot(id)).cursor;
    const before = parts?.[1];
    if (!Number.isSafeInteger(through) || through < -1 || (before !== undefined && (!Number.isSafeInteger(before) || before > through))) throw new Error("history_cursor_invalid");
    if (through < 0) {
      this.transportHealthy = true; this.historyReadable = true;
      return { messages: [], cursor: null, completeUserHistory: false };
    }
    const page = await this.host.pageHistory(id, through, before);
    if (page.truncated) throw new Error("history_unavailable");
    const events = page.events.slice().sort((a, b) => a.seq - b.seq);
    const selected = events.slice(-Math.min(limit, 20));
    const messages: WebMessage[] = [];
    for (const event of selected) {
      if (event.type !== "turn/end" || event.turn === undefined) continue;
      const key = `${id}:${event.seq}:${event.turn}`;
      let message = this.summaryCache.get(key);
      if (message === undefined && !this.summaryCache.has(key)) {
        const summary = await this.host.getTurnSummary(id, event.turn, event.seq);
        message = summary.assistantText !== null
          ? { id: `dsh-${event.turn}-${summary.assistantSeq}`, role: "assistant", text: summary.assistantText, createdAt: Number.isFinite(event.time) ? event.time : null }
          : null;
        this.summaryCache.set(key, message);
        if (this.summaryCache.size > 1000) this.summaryCache.delete(this.summaryCache.keys().next().value!);
      }
      if (message) messages.push(message);
    }
    const oldest = selected[0]?.seq;
    const more = page.hasMore || events.length > selected.length;
    if (more && (oldest === undefined || (before !== undefined && oldest >= before))) throw new Error("history_cursor_stalled");
    this.transportHealthy = true; this.historyReadable = true;
    return { messages: cursor ? messages : [...this.snapshots(id), ...messages], cursor: more && oldest !== undefined ? `${through}:${oldest}` : null, completeUserHistory: false };
  }

  /** Create a deterministic Web session, preserving partial-success identity immediately. */
  async create(input: CreateRequest): Promise<SourceResult> {
    if (!this.reads || !this.writes) return { state: "failed", sessionId: null, errorCode: "writes_disabled" };
    if (!input.prompt.trim() || input.prompt.length > DSH_PROMPT_MAX_CHARS) {
      return { state: "failed", sessionId: null, errorCode: "validation_failed" };
    }
    let projects: CatalogItem[];
    try { projects = await this.projects(); }
    catch { return { state: "failed", sessionId: null, errorCode: "source_unavailable" }; }
    if (!projects.some((project) => project.id === input.projectId)) return { state: "failed", sessionId: null, errorCode: "project_missing" };
    let selection: DshModelSelection | null = null;
    if (input.modelId) {
      let models: CatalogItem[];
      try { models = await this.models(); }
      catch { return { state: "failed", sessionId: null, errorCode: "source_unavailable" }; }
      if (!models.some((model) => model.id === input.modelId)) return { state: "failed", sessionId: null, errorCode: "model_unavailable" };
      selection = JSON.parse(Buffer.from(input.modelId, "base64url").toString()) as DshModelSelection;
    }
    const expected = `session-sea-bridge-web-${suffix(input.operationId)}`;
    let known: string | null = null;
    try {
      const created = await this.host.createSession(input.projectId, expected);
      if (created.status !== "accepted") return { state: created.status === "rejected" ? "failed" : "delivery_unknown", sessionId: created.status === "rejected" ? null : expected, errorCode: created.errorCode };
      known = created.sessionId; input.onSessionKnown(known);
      if (selection) {
        const selected = await this.host.selectModel(known, selection);
        if (selected.status !== "accepted") {
          return { state: selected.status === "rejected" ? "failed" : "delivery_unknown", sessionId: known, errorCode: selected.errorCode };
        }
      }
      return writeResult(await this.host.submitPrompt(known, `sea-bridge-web-${suffix(input.operationId)}`, input.prompt), known);
    } catch { return { state: "delivery_unknown", sessionId: known ?? expected, errorCode: "create_unconfirmed" }; }
  }

  /** Submit using a stable Web request ID; never auto-retry busy or unknown outcomes. */
  async send(id: string, operationId: string, prompt: string): Promise<SourceResult> {
    if (!this.reads || !this.writes) return { state: "failed", sessionId: id, errorCode: "writes_disabled" };
    if (!DSH_SESSION_ID.test(id)) return { state: "failed", sessionId: id, errorCode: "invalid_session" };
    if (!prompt.trim() || prompt.length > DSH_PROMPT_MAX_CHARS) return { state: "failed", sessionId: id, errorCode: "validation_failed" };
    try { return writeResult(await this.host.submitPrompt(id, `sea-bridge-web-${suffix(operationId)}`, prompt), id); }
    catch { return { state: "delivery_unknown", sessionId: id, errorCode: "send_unconfirmed" }; }
  }

  /** Refuse read access before touching a disabled Host. */
  private requireRead(): void { if (!this.reads) throw new Error("source_disabled"); }

  /** Cache discovery calls rather than probing per browser status poll. */
  private async probe(): Promise<void> {
    this.requireRead();
    try { await this.host.health(); this.transportHealthy = true; }
    catch { this.transportHealthy = false; throw new Error("source_unavailable"); }
  }
}

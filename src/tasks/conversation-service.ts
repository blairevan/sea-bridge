import type { ProjectItem } from '../desktop/codex-app-server-client.ts';
import type { SourceResult } from '../web/sources/types.ts';
import { ConversationStore } from './conversation-store.ts';
import type { TaskRunner } from './codex-runner.ts';
import { identifier, parseTaskTurn, TaskBridgeError, type TaskOperation, type TaskTurnInput } from './contract.ts';
import { verifyTaskTarget } from './target.ts';

export interface TaskConversationOptions {
  projects: () => Promise<ProjectItem[]>;
  workspaceRoot: string;
  registerThread: (threadId: string) => void;
  openDesktop?: (threadId: string) => Promise<void>;
  followup?: (operation: TaskOperation, requestId: string, prompt: string) => Promise<void>;
}

/** One durable task operation corresponds to one admitted native turn; delivery and completion stay separate. */
export class TaskConversationService {
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly guarding = new Map<string, Promise<TaskOperation>>();
  constructor(readonly store: ConversationStore, private readonly runner: TaskRunner, private readonly options: TaskConversationOptions) {}

  /** Persist the request before crossing the source boundary, then return without waiting for the model. */
  submit(value: unknown): TaskOperation {
    if (this.stopped) throw new TaskBridgeError('task_bridge_stopping', 503);
    const input = parseTaskTurn(value);
    const { operation, created } = this.store.claim(input);
    if (created) {
      const pending = this.dispatch(input).finally(() => { this.pending.delete(pending); });
      this.pending.add(pending);
    }
    return this.store.get(operation.id)!;
  }

  /** No exception can turn an uncertain source call into a retriable new thread. */
  private async dispatch(input: TaskTurnInput): Promise<void> {
    let crossing = false;
    try {
      const target = verifyTaskTarget(input, await this.options.projects(), this.options.workspaceRoot);
      if (this.stopped) throw new TaskBridgeError('task_bridge_stopping', 503);
      this.store.patch(input.operationId, { state: 'starting' });
      crossing = true;
      await this.runner.start(input, target, this.store.get(input.operationId)!.threadId, {
        thread: id => { this.store.patch(input.operationId, { threadId: id }); this.options.registerThread(id); },
        turn: id => { this.store.patch(input.operationId, { turnId: id, state: 'running' }); },
        settled: (state, report, error) => { this.store.patch(input.operationId, { state, report, error }); },
      });
    } catch (error) {
      this.store.patch(input.operationId, { state: crossing ? 'unknown' : 'failed', released: !crossing,
        error: error instanceof TaskBridgeError ? error.message : crossing ? 'dispatch_unconfirmed' : 'task_preflight_failed' });
    }
  }

  /** The request owns its opaque operation ID, not an arbitrary thread path. */
  get(id: string): TaskOperation {
    const op = this.store.get(identifier(id));
    if (!op) throw new TaskBridgeError('operation_not_found', 404);
    return op;
  }

  /** Only the exact recorded turn may receive an interrupt. */
  async interrupt(id: string, turnId: string): Promise<TaskOperation> {
    const op = this.get(id);
    if (!op.turnId || op.turnId !== turnId) throw new TaskBridgeError('turn_changed', 409);
    if (['succeeded', 'failed', 'interrupted'].includes(op.state)) return op;
    await this.runner.interrupt(op); return this.get(id);
  }

  /** Release only confirmed terminal work; unknown operations require reconciliation rather than replay. */
  async release(id: string): Promise<TaskOperation> {
    const op = this.get(id);
    if (op.released) return op;
    if (!['succeeded', 'failed', 'interrupted'].includes(op.state)) throw new TaskBridgeError('turn_not_terminal', 409);
    if (!await this.runner.release(op)) throw new TaskBridgeError('writer_release_unconfirmed', 503);
    return this.store.patch(id, { released: true });
  }

  /** A held writer fences external edits while ToolHub checks or integrates the exact candidate. */
  async guard(id: string): Promise<TaskOperation> {
    const existing = this.guarding.get(id);
    if (existing) return existing;
    const pending = this.acquireGuard(id).finally(() => { this.guarding.delete(id); });
    this.guarding.set(id, pending);
    return pending;
  }

  /** Coalesce concurrent admission so a second reader cannot undo the first writer fence. */
  private async acquireGuard(id: string): Promise<TaskOperation> {
    const op = this.get(id);
    if (op.state !== 'succeeded' || this.store.latest(op.taskId)?.id !== op.id) throw new TaskBridgeError('candidate_turn_changed', 409);
    this.store.patch(id, { released: false });
    try {
      const input = this.store.input(id);
      const target = verifyTaskTarget(input, await this.options.projects(), this.options.workspaceRoot);
      await this.runner.guard(input, target, op);
      return this.get(id);
    } catch (error) {
      this.store.patch(id, { released: op.released });
      throw error;
    }
  }

  /** Reconcile native evidence after restart without resending the user's demand or creating a new thread. */
  async reconcile(id: string): Promise<TaskOperation> {
    const op = this.get(id);
    if (op.state !== 'unknown' || !this.runner.reconcile) throw new TaskBridgeError('reconciliation_not_available', 409);
    const input = this.store.input(id);
    const target = verifyTaskTarget(input, await this.options.projects(), this.options.workspaceRoot, true);
    const result = await this.runner.reconcile(input, target, op);
    return this.store.patch(id, { ...result, released: false });
  }

  /** Native history stays available even while a task writer is retained for validation. */
  locked(threadId: string): boolean { return this.store.forThread(threadId)?.released === false; }

  /** Expose activity, not ownership, so validation is not mislabelled as model execution. */
  activity(threadId: string): { state: 'active' | 'idle' | 'unknown'; turnId: string | null } | null {
    const op = this.store.forThread(threadId);
    if (!op || op.released) return null;
    return { state: ['received', 'starting', 'running'].includes(op.state) ? 'active' : op.state === 'unknown' ? 'unknown' : 'idle', turnId: op.turnId };
  }

  /** SeaBridge's stop button routes to the same task-owned process, never a separate controlling writer. */
  async interruptThread(threadId: string, turnId: string): Promise<boolean> {
    const op = this.store.forThread(threadId);
    if (!op || op.released) return false;
    await this.interrupt(op.id, turnId); return true;
  }

  /** Managed Web follow-ups invalidate old delivery through the task owner instead of bypassing its checks. */
  async send(threadId: string, operationId: string, prompt: string): Promise<SourceResult | null> {
    const op = this.store.forThread(threadId);
    if (!op) return null;
    if (!op.released || ['received', 'starting', 'running', 'unknown'].includes(op.state)) return { state: 'failed', sessionId: threadId, errorCode: 'task_busy_or_unconfirmed' };
    if (!this.options.followup) return { state: 'failed', sessionId: threadId, errorCode: 'task_followup_unavailable' };
    try {
      await this.options.followup(op, operationId, prompt);
      return { state: 'queued', sessionId: threadId };
    } catch { return { state: 'delivery_unknown', sessionId: threadId, errorCode: 'task_followup_unconfirmed' }; }
  }

  /** Opening is explicit, and never used as proof that execution or delivery completed. */
  async open(id: string): Promise<void> {
    const op = this.get(id);
    if (!op.threadId || !this.options.openDesktop) throw new TaskBridgeError('desktop_open_unavailable', 503);
    await this.options.openDesktop(op.threadId);
  }

  /** Drain admission before shutting down owned source sessions. */
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.guarding.values()]);
    await this.runner.close();
  }
}

import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { TaskBridgeError, type TaskOperation, type TaskTurnInput } from './contract.ts';

/** Durable operation claims are separate from model narrative and browser login state. */
export class ConversationStore {
  readonly instanceId: string;
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_bridge_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,
        digest TEXT NOT NULL,input TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_bridge_task ON task_bridge_operations(task_id);`);
    db.query("INSERT OR IGNORE INTO task_bridge_meta VALUES('instance',?)").run(randomUUID());
    const row = db.query<{ value: string }, []>("SELECT value FROM task_bridge_meta WHERE key='instance'").get();
    if (!row) throw new TaskBridgeError('bridge_instance_missing', 503);
    this.instanceId = row.value;
  }

  /** Resolve an exact receipt; absence never implies a failed downstream request. */
  get(id: string): TaskOperation | null {
    const row = this.db.query<{ data: string }, [string]>('SELECT data FROM task_bridge_operations WHERE id=?').get(id);
    return row ? JSON.parse(row.data) as TaskOperation : null;
  }

  /** The stored request, never a new caller payload, is used when reconciling or guarding a turn. */
  input(id: string): TaskTurnInput {
    const row = this.db.query<{ input: string }, [string]>('SELECT input FROM task_bridge_operations WHERE id=?').get(id);
    if (!row) throw new TaskBridgeError('operation_not_found', 404);
    return JSON.parse(row.input) as TaskTurnInput;
  }

  /** Find the latest operation without trusting user supplied thread identifiers. */
  latest(taskId: string): TaskOperation | null {
    const row = this.db.query<{ data: string }, [string]>('SELECT data FROM task_bridge_operations WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId);
    return row ? JSON.parse(row.data) as TaskOperation : null;
  }

  /** Resolve a registered thread for SeaBridge's existing message entry point. */
  forThread(threadId: string): TaskOperation | null {
    const rows = this.db.query<{ data: string }, []>('SELECT data FROM task_bridge_operations ORDER BY rowid DESC LIMIT 10000').all();
    return rows.map(row => JSON.parse(row.data) as TaskOperation).find(op => op.threadId === threadId) ?? null;
  }

  /** Persist exactly one operation before sending anything to Codex. */
  claim(input: TaskTurnInput): { created: boolean; operation: TaskOperation } {
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(() => {
      const row = this.db.query<{ digest: string }, [string]>('SELECT digest FROM task_bridge_operations WHERE id=?').get(input.operationId);
      if (row) {
        if (row.digest !== digest) throw new TaskBridgeError('operation_conflict', 409);
        return { created: false, operation: this.get(input.operationId)! };
      }
      const last = this.latest(input.taskId);
      if (last && (!last.released || ['received', 'starting', 'running', 'unknown'].includes(last.state))) throw new TaskBridgeError('task_conversation_busy', 409);
      if (last && input.revision < last.revision) throw new TaskBridgeError('stale_task_revision', 409);
      const sameOwner = last?.projectId === input.projectId && last.repositoryPath === input.repositoryPath;
      const now = Date.now();
      const op: TaskOperation = { id: input.operationId, instanceId: this.instanceId, taskId: input.taskId,
        revision: input.revision, projectId: input.projectId, repositoryPath: input.repositoryPath,
        worktreePath: input.worktreePath, mode: input.mode, threadId: sameOwner ? last.threadId : null,
        turnId: null, state: 'received', released: false, error: null, report: null, createdAt: now, updatedAt: now };
      this.db.query('INSERT INTO task_bridge_operations VALUES(?,?,?,?,?)').run(op.id, op.taskId, digest, JSON.stringify(input), JSON.stringify(op));
      return { created: true, operation: op };
    }).immediate();
  }

  /** Update only lifecycle facts; the immutable input and deduplication digest are never replaced. */
  patch(id: string, change: Partial<Pick<TaskOperation, 'threadId' | 'turnId' | 'state' | 'released' | 'error' | 'report'>>): TaskOperation {
    const current = this.get(id);
    if (!current) throw new TaskBridgeError('operation_not_found', 404);
    const updated = { ...current, ...change, updatedAt: Date.now() };
    this.db.query('UPDATE task_bridge_operations SET data=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  }

  /** A process restart loses ownership knowledge, not the downstream operation identity. */
  recover(): void {
    const rows = this.db.query<{ id: string; data: string }, []>('SELECT id,data FROM task_bridge_operations').all();
    for (const row of rows) {
      const op = JSON.parse(row.data) as TaskOperation;
      if (!op.released) this.patch(op.id, { state: 'unknown', error: 'bridge_restarted_reconciliation_required' });
    }
  }
}

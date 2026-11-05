import { isAbsolute } from 'node:path';

export type TaskTurnState = 'received' | 'starting' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
export interface TaskTurnInput {
  operationId: string; taskId: string; runId: string; revision: number;
  projectId: string; repositoryPath: string; worktreePath: string; baseSha: string;
  mode: 'implement' | 'review'; model: string | null; reasoningEffort: string | null; prompt: string;
}
export interface TaskTurnReport { summary: string; details: string; limitations: string[] }
export interface TaskOperation {
  id: string; instanceId: string; taskId: string; revision: number; projectId: string;
  repositoryPath: string; worktreePath: string; mode: TaskTurnInput['mode'];
  threadId: string | null; turnId: string | null; state: TaskTurnState;
  released: boolean; error: string | null; report: TaskTurnReport | null;
  createdAt: number; updatedAt: number;
}

/** Only safe contract errors cross the private service boundary. */
export class TaskBridgeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Reject arrays and primitive data at untrusted JSON boundaries. */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskBridgeError('invalid_object');
  return value as Record<string, unknown>;
}

/** A bounded nonempty field is data, not a command or path authority. */
export function field(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TaskBridgeError('invalid_field');
  return value.trim();
}

/** Task/run identities must be safe opaque identifiers, never file paths. */
export function identifier(value: unknown): string {
  const id = field(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new TaskBridgeError('invalid_identifier');
  return id;
}

/** Validate model choices as one structured field; credentials are never accepted. */
function modelName(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const name = field(value, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(name)) throw new TaskBridgeError('invalid_model');
  return name;
}

/** Syntax is checked here; actual containment and Git identity are checked independently. */
function absolutePath(value: unknown): string {
  const path = field(value, 2048);
  if (!isAbsolute(path) || path === '/' || /[\r\n]/.test(path) || path.split('/').includes('..')) throw new TaskBridgeError('invalid_path');
  return path;
}

/** Normalize a complete immutable request before hashing or dispatching it. */
export function parseTaskTurn(value: unknown): TaskTurnInput {
  const data = record(value);
  if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 1) throw new TaskBridgeError('invalid_revision');
  if (data.mode !== 'implement' && data.mode !== 'review') throw new TaskBridgeError('invalid_mode');
  const baseSha = field(data.baseSha, 40);
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new TaskBridgeError('invalid_base_sha');
  return { operationId: identifier(data.operationId), taskId: identifier(data.taskId), runId: identifier(data.runId),
    revision: Number(data.revision), projectId: identifier(data.projectId),
    repositoryPath: absolutePath(data.repositoryPath), worktreePath: absolutePath(data.worktreePath), baseSha,
    mode: data.mode, model: modelName(data.model), reasoningEffort: modelName(data.reasoningEffort), prompt: field(data.prompt, 48000) };
}

/** Parse the model report, which is narrative only and never an execution receipt. */
export function parseTurnReport(value: unknown): TaskTurnReport {
  const data = record(value);
  if (!Array.isArray(data.limitations) || data.limitations.length > 30) throw new TaskBridgeError('invalid_report');
  return { summary: field(data.summary, 4000), details: field(data.details, 24000), limitations: data.limitations.map(item => field(item, 1000)) };
}

export const TASK_REPORT_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'details', 'limitations'],
  properties: { summary: { type: 'string' }, details: { type: 'string' }, limitations: { type: 'array', items: { type: 'string' } } } };

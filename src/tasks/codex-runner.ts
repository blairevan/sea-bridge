import { dirname, join } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { AppServerSession, spawnAppServerProcess, type ProcessSpawner } from '../desktop/codex-app-server-client.ts';
import { TASK_REPORT_SCHEMA, TaskBridgeError, field, parseTurnReport, record,
  type TaskOperation, type TaskTurnInput, type TaskTurnReport, type TaskTurnState } from './contract.ts';
import type { VerifiedTaskTarget } from './target.ts';

export interface TaskRunnerHooks {
  thread(id: string): void;
  turn(id: string): void;
  settled(state: TaskTurnState, report: TaskTurnReport | null, error: string | null): void;
}
export interface TaskRunner {
  start(input: TaskTurnInput, target: VerifiedTaskTarget, threadId: string | null, hooks: TaskRunnerHooks): Promise<void>;
  interrupt(operation: TaskOperation): Promise<void>;
  release(operation: TaskOperation): Promise<boolean>;
  guard(input: TaskTurnInput, target: VerifiedTaskTarget, operation: TaskOperation): Promise<void>;
  reconcile?(input: TaskTurnInput, target: VerifiedTaskTarget, operation: TaskOperation): Promise<{
    state: 'succeeded' | 'failed' | 'interrupted'; report: TaskTurnReport | null; error: string | null;
  }>;
  close(): Promise<void>;
}
interface OwnedTask {
  session: AppServerSession; threadId: string | null; turnId: string | null;
  settled: boolean; completion: Promise<void> | null;
}

/** Build a task-local profile; do not inherit Desktop full-access or browser-supplied permissions. */
export function taskCodexArguments(target: VerifiedTaskTarget, codexHome: string): string[] {
  const common: Record<string, string> = { ':root': 'deny', ':minimal': 'read', ':tmpdir': 'write', ':slash_tmp': 'deny',
    [target.temporary]: 'write', [target.commonDir]: 'read', [dirname(realpathSync(process.execPath))]: 'read' };
  const profiles = ['sea_task', 'sea_task_read'].flatMap(name => {
    const files = { ...common, [target.worktree]: name === 'sea_task' ? 'write' : 'read',
      [join(target.worktree, '.git')]: 'read', [join(target.worktree, '.codex')]: 'read', [join(target.worktree, '.agents')]: 'read' };
    return ['-c', `permissions.${name}.filesystem={` + Object.entries(files).map(([path, mode]) => JSON.stringify(path) + '=' + JSON.stringify(mode)).join(',') + '}',
      '-c', `permissions.${name}.network.enabled=false`];
  });
  const toolEnv = { HOME: join(target.temporary, 'home'), TMPDIR: target.temporary,
    PATH: [dirname(realpathSync(process.execPath)), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' };
  const args = ['app-server', '--stdio', ...profiles, '-c', 'web_search="disabled"',
    '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.shell_snapshot=false',
    '-c', 'shell_environment_policy.inherit="none"', '-c', 'shell_environment_policy.experimental_use_profile=false',
    '-c', 'shell_environment_policy.set={' + Object.entries(toolEnv).map(([key, value]) => JSON.stringify(key) + '=' + JSON.stringify(value)).join(',') + '}'];
  // An empty TOML table does not disable inherited MCP entries. Disable configured entries by name.
  const configPath = join(codexHome, 'config.toml');
  if (existsSync(configPath)) {
    const config = record(Bun.TOML.parse(readFileSync(configPath, 'utf8')));
    if (config.mcp_servers && typeof config.mcp_servers === 'object') {
      for (const name of Object.keys(config.mcp_servers)) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TaskBridgeError('mcp_configuration_key_requires_review', 503);
        args.push('-c', 'mcp_servers.' + name + '.enabled=false');
      }
    }
  }
  return args;
}

/** Extract only the final agent report for the exact turn, not a previous answer or command output. */
export function reportForTurn(turn: unknown, expectedTurnId: string): TaskTurnReport {
  const data = record(turn);
  if (data.id !== expectedTurnId || data.status !== 'completed' || !Array.isArray(data.items)) throw new TaskBridgeError('turn_not_successful', 409);
  const messages = data.items.filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => item as Record<string, unknown>)
    .filter(item => item.type === 'agentMessage' && typeof item.text === 'string' && (!item.phase || item.phase === 'final_answer'));
  const last = messages.at(-1);
  if (!last || typeof last.text !== 'string' || last.text.length > 36000) throw new TaskBridgeError('task_report_missing', 409);
  try { return parseTurnReport(JSON.parse(last.text) as unknown); }
  catch { throw new TaskBridgeError('task_report_invalid', 409); }
}

/** SeaBridge owns persistent App Server turns; ToolHub never starts a hidden model process. */
export class TaskCodexRunner implements TaskRunner {
  private readonly owned = new Map<string, OwnedTask>();
  constructor(private readonly binary: string, private readonly codexHome: string,
    private readonly spawner: ProcessSpawner = spawnAppServerProcess,
    private readonly turnTimeoutMs = 30 * 60_000) {}

  /** Keep model credentials on the host, with a separate fixed environment for its tools. */
  private async open(target: VerifiedTaskTarget): Promise<AppServerSession> {
    const args = taskCodexArguments(target, this.codexHome);
    const child = this.spawner(this.binary, args, { HOME: homedir(), CODEX_HOME: this.codexHome,
      TMPDIR: target.temporary, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8' });
    const session = new AppServerSession(child, 15000);
    try { await session.initialize(); return session; }
    catch (error) { await session.closeGracefully(); throw error; }
  }

  /** Validate native persistent identity independently of the submitted task metadata. */
  private async readThread(session: AppServerSession, threadId: string, projectId: string, includeTurns = true): Promise<Record<string, unknown>> {
    const reply = await session.request<{ thread?: unknown }>('thread/read', { threadId, includeTurns });
    const thread = record(reply.thread);
    if (thread.id !== threadId || thread.ephemeral !== false ||
      (thread.projectId != null && thread.projectId !== projectId)) throw new TaskBridgeError('persistent_project_binding_unconfirmed', 409);
    // The installed Desktop backend omits projectId on its active-writer
    // projection. A separate metadata-only reader sees the persisted assignment.
    // It never resumes a writer or modifies Codex's internal database.
    if (thread.projectId == null) await this.verifyStoredProject(threadId, projectId);
    return thread;
  }

  /** Verify durable identity independently when the active projection is incomplete. */
  private async verifyStoredProject(threadId: string, projectId: string): Promise<void> {
    const reader = new AppServerSession(this.spawner(this.binary, ['app-server', '--stdio'], {
      HOME: homedir(), CODEX_HOME: this.codexHome, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
    }), 15000);
    try {
      await reader.initialize();
      for (let attempt = 0; attempt < 10; attempt++) {
        const reply = await reader.request<{ thread?: unknown }>('thread/read', { threadId, includeTurns: false });
        const stored = record(reply.thread);
        if (stored.id !== threadId || stored.ephemeral !== false ||
          (stored.projectId != null && stored.projectId !== projectId)) throw new TaskBridgeError('persistent_project_binding_unconfirmed', 409);
        if (stored.projectId === projectId) return;
        if (attempt < 9) await Bun.sleep(100);
      }
      throw new TaskBridgeError('persistent_project_binding_unconfirmed', 409);
    } finally { await reader.closeGracefully(); }
  }

  /** Start or resume one native conversation and retain its writer until supervised checks finish. */
  async start(input: TaskTurnInput, target: VerifiedTaskTarget, threadId: string | null, hooks: TaskRunnerHooks): Promise<void> {
    let session = await this.open(target);
    const owned: OwnedTask = { session, threadId, turnId: null, settled: false, completion: null };
    this.owned.set(input.operationId, owned);
    try {
      const permissions = input.mode === 'review' ? 'sea_task_read' : 'sea_task';
      const params = { cwd: target.worktree, permissions, approvalPolicy: 'never',
        runtimeWorkspaceRoots: [target.worktree], ...(input.model ? { model: input.model } : {}) };
      const response = threadId
        ? await session.request<{ thread?: { id?: string } }>('thread/resume', { ...params, threadId })
        : await session.request<{ thread?: { id?: string } }>('thread/start', { ...params, projectId: input.projectId, ephemeral: false });
      const nativeId = response.thread?.id;
      if (!nativeId || (threadId && nativeId !== threadId)) throw new TaskBridgeError('thread_identity_unconfirmed', 503);
      owned.threadId = nativeId; hooks.thread(nativeId);
      if (!threadId) {
        // Newly created empty threads are not yet readable from another native
        // process. Flush creation before resuming that SAME thread for its first
        // model turn; this is not a second create or a replay of the demand.
        await session.closeGracefully();
        if (!session.isClosed()) throw new TaskBridgeError('creation_writer_release_unconfirmed', 503);
        session = await this.open(target); owned.session = session;
        const resumed = await session.request<{ thread?: { id?: string } }>('thread/resume', { ...params, threadId: nativeId });
        if (resumed.thread?.id !== nativeId) throw new TaskBridgeError('thread_identity_unconfirmed', 503);
      }
      await this.readThread(session, nativeId, input.projectId, false);
      const reply = await session.request<{ turn?: { id?: string } }>('turn/start', { threadId: nativeId,
        cwd: target.worktree, permissions, approvalPolicy: 'never', runtimeWorkspaceRoots: [target.worktree],
        clientUserMessageId: input.operationId,
        input: [{ type: 'text', text: input.prompt, textElements: [] }], outputSchema: TASK_REPORT_SCHEMA,
        ...(input.model ? { model: input.model } : {}), ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}) });
      if (!reply.turn?.id) throw new TaskBridgeError('turn_identity_unconfirmed', 503);
      owned.turnId = reply.turn.id; hooks.turn(reply.turn.id);
      owned.completion = this.observe(input, owned, hooks);
    } catch (error) {
      await session.closeGracefully();
      if (session.isClosed()) this.owned.delete(input.operationId);
      throw error;
    }
  }

  /** Only a matching terminal notification plus its persisted turn can produce a successful report. */
  private async observe(input: TaskTurnInput, owned: OwnedTask, hooks: TaskRunnerHooks): Promise<void> {
    try {
      const event = await owned.session.waitForNotification(message => message.method === 'turn/completed' &&
        message.params?.threadId === owned.threadId && message.params?.turn?.id === owned.turnId, this.turnTimeoutMs);
      const payload = record(event.params as unknown); const turn = record(payload.turn);
      if (turn.status === 'failed' || turn.status === 'interrupted') {
        owned.settled = true; hooks.settled(turn.status, null, turn.status === 'failed' ? 'codex_turn_failed' : 'codex_turn_interrupted');
        return;
      }
      if (turn.status !== 'completed') throw new TaskBridgeError('terminal_status_unknown', 503);
      const thread = await this.readThread(owned.session, owned.threadId!, input.projectId);
      if (!Array.isArray(thread.turns)) throw new TaskBridgeError('turn_history_missing', 503);
      const found = thread.turns.find(item => record(item).id === owned.turnId);
      const report = reportForTurn(found, owned.turnId!);
      owned.settled = true; hooks.settled('succeeded', report, null);
    } catch {
      await owned.session.closeGracefully();
      if (owned.session.isClosed()) this.owned.delete(input.operationId);
      hooks.settled('unknown', null, 'turn_result_unconfirmed');
    }
  }

  /** Interrupt is scoped to the originally admitted turn and never guesses another current turn. */
  async interrupt(operation: TaskOperation): Promise<void> {
    const owned = this.owned.get(operation.id);
    if (!owned || owned.threadId !== operation.threadId || owned.turnId !== operation.turnId) throw new TaskBridgeError('turn_ownership_unknown', 409);
    if (owned.settled) return;
    await owned.session.request('turn/interrupt', { threadId: owned.threadId, turnId: owned.turnId });
  }

  /** Make continuation read-only before releasing the writer; Desktop remains free to display history. */
  async release(operation: TaskOperation): Promise<boolean> {
    const owned = this.owned.get(operation.id);
    if (!owned) return operation.released;
    if (!owned.settled) throw new TaskBridgeError('turn_not_terminal', 409);
    await owned.session.request('thread/settings/update', { threadId: owned.threadId,
      sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
    await owned.session.closeGracefully();
    if (!owned.session.isClosed()) return false;
    this.owned.delete(operation.id); return true;
  }

  /** Reacquire the same thread, refusing old evidence after another native turn has appeared. */
  async guard(input: TaskTurnInput, target: VerifiedTaskTarget, operation: TaskOperation): Promise<void> {
    const existing = this.owned.get(operation.id);
    if (existing) {
      if (!existing.settled || existing.turnId !== operation.turnId) throw new TaskBridgeError('turn_not_terminal', 409);
      return;
    }
    if (!operation.threadId || !operation.turnId || operation.state !== 'succeeded') throw new TaskBridgeError('no_successful_turn', 409);
    const session = await this.open(target);
    try {
      await session.request('thread/resume', { threadId: operation.threadId, cwd: target.worktree,
        permissions: 'sea_task_read', approvalPolicy: 'never', runtimeWorkspaceRoots: [target.worktree] });
      const thread = await this.readThread(session, operation.threadId, input.projectId);
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const last = turns.at(-1);
      if (!last || record(last).id !== operation.turnId || record(last).status !== 'completed') throw new TaskBridgeError('conversation_changed_reverification_required', 409);
      this.owned.set(operation.id, { session, threadId: operation.threadId, turnId: operation.turnId, settled: true, completion: null });
    } catch (error) { await session.closeGracefully(); throw error; }
  }

  /** Recover only known exact native terminal work; acquiring its writer proves the old owner is gone. */
  async reconcile(input: TaskTurnInput, target: VerifiedTaskTarget, operation: TaskOperation): Promise<{
    state: 'succeeded' | 'failed' | 'interrupted'; report: TaskTurnReport | null; error: string | null;
  }> {
    if (!operation.threadId || !operation.turnId || this.owned.has(operation.id)) throw new TaskBridgeError('reconciliation_identity_or_owner_unknown', 409);
    const session = await this.open(target);
    try {
      const before = await this.readThread(session, operation.threadId, input.projectId);
      const last = Array.isArray(before.turns) ? before.turns.at(-1) : null;
      if (!last || record(last).id !== operation.turnId) throw new TaskBridgeError('conversation_changed_reverification_required', 409);
      const status = record(last).status;
      if (!['completed', 'failed', 'interrupted'].includes(String(status))) throw new TaskBridgeError('native_turn_still_unconfirmed', 409);
      await session.request('thread/resume', { threadId: operation.threadId, cwd: target.worktree,
        permissions: 'sea_task_read', approvalPolicy: 'never', runtimeWorkspaceRoots: [target.worktree] });
      const after = await this.readThread(session, operation.threadId, input.projectId);
      const final = Array.isArray(after.turns) ? after.turns.at(-1) : null;
      if (!final || record(final).id !== operation.turnId || record(final).status !== status) throw new TaskBridgeError('native_turn_changed_during_reconciliation', 409);
      const report = status === 'completed' ? reportForTurn(final, operation.turnId) : null;
      this.owned.set(operation.id, { session, threadId: operation.threadId, turnId: operation.turnId, settled: true, completion: null });
      return { state: status === 'completed' ? 'succeeded' : status as 'failed' | 'interrupted', report,
        error: status === 'completed' ? null : 'native_turn_' + String(status) };
    } catch (error) { await session.closeGracefully(); throw error; }
  }

  /** Service shutdown releases only its own protocol processes, never kills an external Desktop writer. */
  async close(): Promise<void> {
    const owners = [...this.owned.values()];
    await Promise.all(owners.map(async owned => { await owned.session.closeGracefully(); }));
    await Promise.allSettled(owners.map(owned => owned.completion));
    this.owned.clear();
  }
}

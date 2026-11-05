import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskConversationService } from '../src/tasks/conversation-service.ts';
import { ConversationStore } from '../src/tasks/conversation-store.ts';
import { taskGit, verifyTaskTarget } from '../src/tasks/target.ts';
import { taskBridgeHandler } from '../src/tasks/server.ts';
import type { TaskRunner, TaskRunnerHooks } from '../src/tasks/codex-runner.ts';
import type { TaskTurnInput } from '../src/tasks/contract.ts';

/** Real isolated Git identities exercise validation without touching registered production projects. */
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sea-task-service-')));
  const repository = join(directory, 'repo'); mkdirSync(repository);
  taskGit(repository, ['init', '-b', 'main']); taskGit(repository, ['config', 'user.name', 'Fixture']);
  taskGit(repository, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repository, 'app.txt'), 'fixture\n'); taskGit(repository, ['add', 'app.txt']); taskGit(repository, ['commit', '-m', 'fixture']);
  const workspaceRoot = join(directory, 'engineering'); mkdirSync(workspaceRoot, { mode: 0o700 });
  const worktree = join(workspaceRoot, 'task-id', 'run-id', 'worktree'); mkdirSync(join(workspaceRoot, 'task-id', 'run-id'), { recursive: true });
  taskGit(repository, ['worktree', 'add', '-b', 'task-fixture', worktree]);
  const input: TaskTurnInput = { operationId: 'op-id', taskId: 'task-id', runId: 'run-id', revision: 1,
    projectId: 'project-id', repositoryPath: repository, worktreePath: worktree, baseSha: taskGit(repository, ['rev-parse', 'HEAD']),
    mode: 'review', model: null, reasoningEffort: null, prompt: 'read-only handoff' };
  const projects = [{ id: 'project-id', name: 'Tools', index: 1, position: 1, roots: [directory], primaryRoot: directory }];
  const db = new Database(':memory:'); const store = new ConversationStore(db);
  let starts = 0; let hooks: TaskRunnerHooks | undefined; let registered = '';
  const runner: TaskRunner = {
    async start(_input, _target, _thread, callbacks) { starts++; hooks = callbacks; callbacks.thread('thread-id'); callbacks.turn('turn-id'); },
    async interrupt() { hooks?.settled('interrupted', null, 'interrupted'); },
    async release() { return true; }, async guard() {}, async close() {},
  };
  const service = new TaskConversationService(store, runner, { projects: async () => projects, workspaceRoot,
    registerThread: id => { registered = id; } });
  return { directory, workspaceRoot, input, projects, db, store, service, get starts() { return starts; }, get registered() { return registered; },
    finish() { hooks?.settled('succeeded', { summary: 'checked', details: 'existing code only', limitations: [] }, null); },
    async close() { await service.close(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe('private task ingress and source ownership', () => {
  test('persists one thread with the original project, and does not conflate admission with completion', async () => {
    const f = fixture();
    try {
      const first = f.service.submit(f.input); expect(first.state).not.toBe('succeeded');
      for (let n = 0; n < 50 && f.service.get(first.id).state !== 'running'; n++) await Bun.sleep(2);
      expect(f.service.get(first.id).threadId).toBe('thread-id'); expect(f.registered).toBe('thread-id');
      expect(f.service.submit(f.input).id).toBe(first.id); expect(f.starts).toBe(1);
      await expect(f.service.release(first.id)).rejects.toThrow('terminal');
      f.finish(); expect(f.service.get(first.id).state).toBe('succeeded');
      expect(f.service.locked('thread-id')).toBe(true);
      await f.service.release(first.id); expect(f.service.locked('thread-id')).toBe(false);
      expect(f.service.activity('thread-id')).toBeNull();
      expect(await f.service.interruptThread('thread-id', 'later-desktop-turn')).toBe(false);
      expect(f.service.get(first.id).report?.summary).toBe('checked');
    } finally { await f.close(); }
  });
  test('private routes reject browsers and malformed identities without dispatching', async () => {
    const f = fixture(); const handler = taskBridgeHandler(f.service);
    try {
      const request = (value: unknown, headers: Record<string, string> = {}) => new Request('http://local/v1/turns', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
      expect((await handler(request(f.input, { Origin: 'http://localhost' }))).status).toBe(403);
      expect((await handler(request({ ...f.input, taskId: '../escape' }))).status).toBe(400);
      expect((await handler(request(f.input))).status).toBe(202);
      await Bun.sleep(10);
      expect((await handler(request(f.input))).status).toBe(202); expect(f.starts).toBe(1);
      expect((await handler(request({ ...f.input, prompt: 'different' }))).status).toBe(409);
      const wrong = await handler(new Request('http://local/v1/operations/op-id/interrupt', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId: 'other-turn' }) }));
      expect(wrong.status).toBe(409);
    } finally { await f.close(); }
  });
  test('refuses foreign worktrees, symlink escapes, and dirty candidates before contacting Codex', async () => {
    const f = fixture();
    try {
      expect(verifyTaskTarget(f.input, f.projects, f.workspaceRoot).repository).toBe(f.input.repositoryPath);
      expect(() => verifyTaskTarget({ ...f.input, projectId: 'missing' }, f.projects, f.workspaceRoot)).toThrow('project');
      expect(() => verifyTaskTarget({ ...f.input, worktreePath: f.input.repositoryPath }, f.projects, f.workspaceRoot)).toThrow('worktree');
      symlinkSync(f.input.worktreePath, join(f.directory, 'alias'));
      expect(() => verifyTaskTarget({ ...f.input, worktreePath: join(f.directory, 'alias'), runId: 'foreign' }, f.projects, f.workspaceRoot)).toThrow();
      writeFileSync(join(f.input.worktreePath, 'operator.txt'), 'preserve');
      const op = f.service.submit(f.input);
      for (let n = 0; n < 50 && f.service.get(op.id).state !== 'failed'; n++) await Bun.sleep(2);
      expect(f.service.get(op.id).error).toBe('worktree_dirty_before_dispatch'); expect(f.starts).toBe(0);
    } finally { await f.close(); }
  });
});

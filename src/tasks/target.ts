import { lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProjectItem } from '../desktop/codex-app-server-client.ts';
import { TaskBridgeError, type TaskTurnInput } from './contract.ts';

export interface VerifiedTaskTarget { repository: string; worktree: string; commonDir: string; temporary: string; projectRoot: string }

/** Run bounded read-only Git queries with fixed argv and no inherited directory overrides. */
export function taskGit(cwd: string, args: string[]): string {
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new TaskBridgeError('repository_verification_failed', 409);
  return result.stdout.trim();
}

/** Only exact descendants qualify, never path-prefix lookalikes. */
export function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('../') && path !== '..' && !path.startsWith('/'));
}

/** Verify the independent Codex owner, contained repository, and supervisor-created worktree. */
export function verifyTaskTarget(input: TaskTurnInput, projects: ProjectItem[], workspaceRoot: string, allowDirty = false): VerifiedTaskTarget {
  try {
    const project = projects.find(item => item.id === input.projectId);
    if (!project) throw new TaskBridgeError('project_missing', 409);
    const repository = realpathSync(input.repositoryPath);
    const projectRoot = project.roots.map(path => realpathSync(path)).find(path => within(path, repository));
    if (!projectRoot) throw new TaskBridgeError('repository_outside_project', 403);
    if (realpathSync(taskGit(repository, ['rev-parse', '--show-toplevel'])) !== repository) throw new TaskBridgeError('repository_not_root', 409);
    const worktree = realpathSync(input.worktreePath);
    const root = realpathSync(workspaceRoot);
    if (lstatSync(workspaceRoot).isSymbolicLink() || (lstatSync(root).mode & 0o077) !== 0 ||
      (process.getuid && lstatSync(root).uid !== process.getuid())) throw new TaskBridgeError('workspace_root_not_private', 403);
    const expected = join(root, input.taskId, input.runId, 'worktree');
    if (worktree !== expected || !within(root, worktree) || worktree === repository) throw new TaskBridgeError('worktree_outside_task', 403);
    if (realpathSync(taskGit(worktree, ['rev-parse', '--show-toplevel'])) !== worktree) throw new TaskBridgeError('worktree_not_root', 409);
    const commonDir = realpathSync(resolve(repository, taskGit(repository, ['rev-parse', '--git-common-dir'])));
    const other = realpathSync(resolve(worktree, taskGit(worktree, ['rev-parse', '--git-common-dir'])));
    if (commonDir !== other) throw new TaskBridgeError('worktree_repository_mismatch', 403);
    taskGit(worktree, ['merge-base', '--is-ancestor', input.baseSha, 'HEAD']);
    if (!allowDirty && taskGit(worktree, ['status', '--porcelain', '--untracked-files=all'])) throw new TaskBridgeError('worktree_dirty_before_dispatch', 409);
    const temporary = join(dirname(worktree), 'sea-runtime');
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    if (lstatSync(temporary).isSymbolicLink() || realpathSync(temporary) !== temporary) throw new TaskBridgeError('runtime_path_unsafe', 403);
    mkdirSync(join(temporary, 'home'), { recursive: true, mode: 0o700 });
    return { repository, worktree, commonDir, temporary, projectRoot };
  } catch (error) {
    if (error instanceof TaskBridgeError) throw error;
    throw new TaskBridgeError('task_paths_unavailable', 409);
  }
}

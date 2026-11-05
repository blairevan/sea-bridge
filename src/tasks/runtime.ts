import type { Database } from 'bun:sqlite';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { lstatSync } from 'node:fs';
import type { ProjectItem } from '../desktop/codex-app-server-client.ts';
import { openCodexDesktopThread } from '../desktop/codex-desktop-opener.ts';
import { ConversationStore } from './conversation-store.ts';
import { TaskCodexRunner } from './codex-runner.ts';
import { TaskConversationService } from './conversation-service.ts';
import { startTaskBridge } from './server.ts';

/** Follow-ups return to ToolHub's versioned state machine rather than launching a competing native writer. */
async function requestFollowup(socket: string, payload: Record<string, unknown>): Promise<void> {
  const parent = lstatSync(dirname(socket)); const stat = lstatSync(socket);
  if (!stat.isSocket() || parent.isSymbolicLink() || (stat.mode & 0o077) || (parent.mode & 0o077) ||
    (process.getuid && (stat.uid !== process.getuid() || parent.uid !== process.getuid()))) throw new Error('task_control_socket_unsafe');
  const response = await fetch('http://toolhub/bridge/followup', { unix: socket, method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!response.ok) throw new Error('task_followup_not_accepted');
}

/** Enable the new private task ingress explicitly, independently from the public Web listener. */
export async function startConfiguredTaskConversations(options: {
  db: Database; dbPath: string; binary: string; codexHome: string;
  projects: () => Promise<ProjectItem[]>; registerThread: (id: string) => void;
}) {
  if (process.env.SEA_BRIDGE_TASKS_ENABLED !== 'true') return null;
  const socket = process.env.SEA_BRIDGE_TASK_SOCKET || join(dirname(options.dbPath), 'run/tasks.sock');
  const workspaceRoot = process.env.SEA_BRIDGE_TASK_WORKSPACE_ROOT || join(homedir(), '.toolhub/tasks/engineering');
  const control = process.env.SEA_BRIDGE_TOOLHUB_CONTROL_SOCKET || join(homedir(), '.toolhub/tasks/control.sock');
  for (const path of [socket, workspaceRoot, control]) if (resolve(path) !== path) throw new Error('task_paths_must_be_absolute');
  const store = new ConversationStore(options.db); store.recover();
  const runner = new TaskCodexRunner(options.binary, options.codexHome);
  const service = new TaskConversationService(store, runner, { workspaceRoot, projects: options.projects,
    registerThread: options.registerThread, openDesktop: openCodexDesktopThread,
    followup: async (op, requestId, prompt) => requestFollowup(control, {
      taskId: op.taskId, threadId: op.threadId, instanceId: store.instanceId, requestId, note: prompt,
    }) });
  const server = await startTaskBridge(socket, service);
  return { service, socket, stop: () => server.stop() };
}

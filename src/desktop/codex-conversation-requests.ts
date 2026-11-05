import type { ResolvedDesktopPermissions } from './desktop-permissions.ts';

/** Native transport shared by Web new-session requests and supervised task sessions. */
export interface ConversationRpc {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}
interface CommonPolicy {
  approvalPolicy: 'never' | 'on-request';
  approvalsReviewer?: ResolvedDesktopPermissions['threadStart']['approvalsReviewer'];
  permissions?: string;
  runtimeWorkspaceRoots?: string[];
}
interface ThreadPolicy extends CommonPolicy {
  sandbox?: ResolvedDesktopPermissions['threadStart']['sandbox'];
}
interface TurnPolicy extends CommonPolicy {
  sandboxPolicy?: ReturnType<ResolvedDesktopPermissions['turnStart']>['sandboxPolicy'];
}

/** Serialize only trusted policy fields, keeping control metadata out of chat input. */
function policyFields(policy?: CommonPolicy): Record<string, unknown> {
  if (!policy) return {};
  return { approvalPolicy: policy.approvalPolicy,
    ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
    ...(policy.permissions ? { permissions: policy.permissions } : {}),
    ...(policy.runtimeWorkspaceRoots ? { runtimeWorkspaceRoots: policy.runtimeWorkspaceRoots } : {}) };
}

/** The ordinary SeaBridge create route and managed tasks create persistent threads identically. */
export async function createNativeConversation(rpc: ConversationRpc, input: {
  projectId: string; cwd: string; model?: string; policy?: ThreadPolicy; developerInstructions?: string;
}): Promise<{ thread?: { id?: string }; model?: string }> {
  if (input.policy?.permissions && input.policy.sandbox) throw new Error('conflicting_thread_permissions');
  return rpc.request('thread/start', { projectId: input.projectId, cwd: input.cwd, ephemeral: false,
    ...policyFields(input.policy), ...(input.policy?.sandbox ? { sandbox: input.policy.sandbox } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}) });
}

/** Send the user's text unchanged. This chat entry point never imposes a machine-output schema. */
export async function sendNativeConversationMessage(rpc: ConversationRpc, input: {
  threadId: string; prompt: string; cwd?: string; model?: string; reasoningEffort?: string | null;
  clientUserMessageId?: string; policy?: TurnPolicy;
}): Promise<{ turn?: { id?: string } }> {
  if (input.policy?.permissions && input.policy.sandboxPolicy) throw new Error('conflicting_turn_permissions');
  return rpc.request('turn/start', { threadId: input.threadId,
    input: [{ type: 'text', text: input.prompt, textElements: [] }],
    ...policyFields(input.policy), ...(input.policy?.sandboxPolicy ? { sandboxPolicy: input.policy.sandboxPolicy } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
    ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}) });
}

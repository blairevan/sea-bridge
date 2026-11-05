import { describe, expect, test } from 'bun:test';
import { createNativeConversation, sendNativeConversationMessage, type ConversationRpc } from '../src/desktop/codex-conversation-requests.ts';

/** Capture exact protocol requests without a real model or the user's Codex home. */
function fixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rpc: ConversationRpc = { async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    calls.push({ method, params });
    return (method === 'thread/start' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } }) as T;
  } };
  return { rpc, calls };
}

describe('shared SeaBridge new-conversation contract', () => {
  test('normal create and managed task create use the same raw prompt without an output schema', async () => {
    const ordinary = fixture(); const managed = fixture();
    const prompt = '为什么 Daily 少了日期？\n请检查原因。';
    await createNativeConversation(ordinary.rpc, { projectId: 'project', cwd: '/repo', policy: { sandbox: 'read-only', approvalPolicy: 'never' } });
    await createNativeConversation(managed.rpc, { projectId: 'project', cwd: '/task/work',
      policy: { permissions: 'sea_task_read', approvalPolicy: 'never' }, developerInstructions: '只读核验，不代表人工验收。' });
    await sendNativeConversationMessage(ordinary.rpc, { threadId: 'thread', prompt });
    await sendNativeConversationMessage(managed.rpc, { threadId: 'thread', prompt, cwd: '/task/work',
      policy: { permissions: 'sea_task_read', approvalPolicy: 'never' }, clientUserMessageId: 'operation' });
    expect(ordinary.calls[1]?.params.input).toEqual(managed.calls[1]?.params.input);
    expect(managed.calls[1]?.params.input).toEqual([{ type: 'text', text: prompt, textElements: [] }]);
    for (const { calls } of [ordinary, managed]) {
      expect(calls.map(call => call.method)).toEqual(['thread/start', 'turn/start']);
      expect(calls[0]?.params.ephemeral).toBe(false);
      expect(calls[1]?.params).not.toHaveProperty('outputSchema');
      expect(calls[1]?.params).not.toHaveProperty('developerInstructions');
    }
  });

  test('continuation preserves user text exactly, even when the user explicitly requests JSON', async () => {
    const f = fixture(); const prompt = '  请给一个 JSON 配置示例。\n';
    await sendNativeConversationMessage(f.rpc, { threadId: 'existing-thread', prompt, reasoningEffort: 'high', model: 'fixture-model' });
    expect(f.calls[0]?.params).toEqual({ threadId: 'existing-thread', input: [{ type: 'text', text: prompt, textElements: [] }], effort: 'high', model: 'fixture-model' });
    expect(f.calls.some(call => call.method === 'thread/start')).toBe(false);
  });
});

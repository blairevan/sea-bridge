import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ConversationStore } from '../src/tasks/conversation-store.ts';
import { parseTaskTurn } from '../src/tasks/contract.ts';

const input = { operationId: '11111111-1111-4111-8111-111111111111', taskId: '22222222-2222-4222-8222-222222222222',
  runId: '11111111-1111-4111-8111-111111111111', revision: 1, projectId: 'project-fixture',
  repositoryPath: '/fixture/repo', worktreePath: '/fixture/tasks/task/run/worktree',
  baseSha: 'a'.repeat(40), model: null, reasoningEffort: null, mode: 'implement' as const, prompt: 'Implement fixture' };

describe('durable task conversation contract', () => {
  test('claims once, rejects changed payloads and fences concurrent runs', () => {
    const db = new Database(':memory:'); const store = new ConversationStore(db);
    try {
      const first = store.claim(parseTaskTurn(input));
      expect(first.created).toBe(true);
      expect(store.claim(parseTaskTurn(input)).created).toBe(false);
      expect(() => store.claim(parseTaskTurn({ ...input, prompt: 'changed' }))).toThrow('conflict');
      expect(() => store.claim(parseTaskTurn({ ...input, operationId: '33333333-3333-4333-8333-333333333333' }))).toThrow('busy');
      store.patch(first.operation.id, { threadId: 'thread-fixture', turnId: 'turn-1', state: 'succeeded', released: true });
      const second = store.claim(parseTaskTurn({ ...input, revision: 2, operationId: '44444444-4444-4444-8444-444444444444' }));
      expect(second.operation.threadId).toBe('thread-fixture');
      expect(second.operation.turnId).toBeNull();
    } finally { db.close(); }
  });
  test('retains uncertain delivery after restart and never creates another thread for it', () => {
    const db = new Database(':memory:');
    try {
      const store = new ConversationStore(db); const op = store.claim(parseTaskTurn(input)).operation;
      store.patch(op.id, { state: 'running', threadId: 'known-thread', turnId: 'known-turn' });
      const reopened = new ConversationStore(db); reopened.recover();
      expect(reopened.get(op.id)?.state).toBe('unknown');
      expect(reopened.claim(parseTaskTurn(input)).operation.threadId).toBe('known-thread');
      expect(reopened.claim(parseTaskTurn(input)).created).toBe(false);
    } finally { db.close(); }
  });
  test('validates all identifiers and rejects paths/options masquerading as requests', () => {
    expect(() => parseTaskTurn({ ...input, mode: 'full-access' })).toThrow();
    expect(() => parseTaskTurn({ ...input, worktreePath: '/tmp/../etc' })).toThrow();
    expect(() => parseTaskTurn({ ...input, revision: 0 })).toThrow();
    expect(() => parseTaskTurn({ ...input, model: '--unsafe' })).toThrow();
    expect(parseTaskTurn({ ...input, mode: 'review' }).mode).toBe('review');
    const context = '工作区和提交证据只作为背景，不要求结构化回复。';
    expect(parseTaskTurn({ ...input, context }).context).toBe(context);
    expect(() => parseTaskTurn({ ...input, context: 'a'.repeat(16001) })).toThrow();
    expect(parseTaskTurn(input)).not.toHaveProperty('context');
  });
});

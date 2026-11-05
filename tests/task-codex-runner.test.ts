import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskCodexRunner, reportForTurn, taskCodexArguments } from '../src/tasks/codex-runner.ts';
import type { TaskOperation, TaskTurnInput, TaskTurnState } from '../src/tasks/contract.ts';

/** A native-protocol fixture exercises actual stdio framing without model/network access. */
function fixture(terminal: 'completed' | 'failed', pendingProjectReads = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sea-native-task-')));
  for (const path of ['home', 'work', 'tmp', 'tmp/home', 'git']) mkdirSync(join(dir, path));
  const fake = join(dir, 'codex-fixture');
  writeFileSync(fake, '#!' + process.execPath + '\n' + `
import {createInterface} from 'node:readline';
let thread='fixture-thread', turn='fixture-turn', project='fixture-project', reads=0, named=false;
const report={summary:'native fixture',details:'bounded native protocol',limitations:[]};
const item={type:'agentMessage',id:'msg',phase:'final_answer',text:JSON.stringify(report)};
const completed={id:turn,status:${JSON.stringify(terminal)},items:[item]};
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line); if(!m.id)continue;const p=m.params||{};
 if(m.method==='initialize'){send({id:m.id,result:{}});continue}
 if(m.method==='thread/start'){
   if(p.ephemeral!==false||p.projectId!==project||p.permissions!=='sea_task_read'||!p.developerInstructions){send({id:m.id,error:{code:-1,message:'bad durable request'}});continue}
   send({id:m.id,result:{thread:{id:thread}}});continue;
 }
 if(m.method==='thread/resume'){send({id:m.id,result:{thread:{id:thread}}});continue}
 if(m.method==='thread/read'){send({id:m.id,result:{thread:{id:thread,projectId:++reads<=${pendingProjectReads}?null:project,ephemeral:false,turns:p.includeTurns?[completed]:[]}}});continue}
 if(m.method==='thread/name/set'){named=p.name==='Readable task';send({id:m.id,result:{}});continue}
 if(m.method==='turn/start'){
  if('outputSchema' in p||!named||p.input[0].text!=='Review fixture only'){send({id:m.id,error:{code:-1,message:'internal JSON leaked into native chat'}});continue}
  send({id:m.id,result:{turn:{id:turn}}});send({method:'turn/completed',params:{threadId:thread,turn:completed}});continue}
 if(m.method==='thread/settings/update'){
  if(p.permissions!=='sea_task_read'||'sandboxPolicy' in p){send({id:m.id,error:{code:-1,message:'lost scoped read profile'}});continue}
  send({id:m.id,result:{}});continue}
 send({id:m.id,result:{}});
}
`, { mode: 0o700 }); chmodSync(fake, 0o700);
  const input: TaskTurnInput = { operationId: 'fixture-operation', taskId: 'fixture-task', runId: 'fixture-run', revision: 1,
    projectId: 'fixture-project', repositoryPath: join(dir, 'work'), worktreePath: join(dir, 'work'),
    baseSha: 'a'.repeat(40), mode: 'review', model: null, reasoningEffort: null, title: 'Readable task', prompt: 'Review fixture only' };
  const target = { repository: input.repositoryPath, worktree: input.worktreePath, temporary: join(dir, 'tmp'),
    commonDir: join(dir, 'git'), projectRoot: dir };
  return { dir, input, target, runner: new TaskCodexRunner(fake, join(dir, 'home'), undefined, 2000) };
}

describe('persistent native task turns', () => {
  test('allows only instruction-file reads needed by a fresh Desktop resume, not whole parent directories', () => {
    const f = fixture('completed');
    try {
      const args = taskCodexArguments(f.target, join(f.dir, 'home'));
      const encoded = args.find(value => value.startsWith('permissions.sea_task_read.filesystem='))!;
      const parsed = Bun.TOML.parse('files=' + encoded.split('filesystem=')[1]!) as { files: Record<string, string> };
      const policy = parsed.files;
      expect(policy[join(f.dir, 'home', 'AGENTS.md')]).toBe('read');
      expect(policy[join(f.dir, 'AGENTS.md')]).toBe('read');
      expect(policy[join(f.dir, 'AGENTS.override.md')]).toBe('read');
      expect(policy[f.dir]).toBeUndefined();
      expect(policy[':root']).toBe('deny');
      expect(policy[join(f.target.worktree, '.git')]).toBe('read');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  test('stores a natural-language final answer without requiring user-visible JSON', () => {
    const answer = '## 核对结果\n\n已核对候选提交，尚未验收或合并。\n\n## 未验证范围\n未读取真实用户数据。';
    const report = reportForTurn({ id: 'turn', status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: answer },
    ] }, 'turn');
    expect(report.details).toBe(answer);
    expect(report.summary).toContain('尚未验收');
    expect(report.limitations.join(' ')).toContain('报告原文');
    const codeExample = '{"enabled":true}\n这是用户要求的配置示例，不是任务协议。';
    expect(reportForTurn({ id: 'turn', status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: codeExample },
    ] }, 'turn').details).toBe(codeExample);
    expect(() => reportForTurn({ id: 'turn', status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: '   ' },
    ] }, 'turn')).toThrow();
  });
  test('waits for project assignment hydration before submitting the first native turn', async () => {
    const f = fixture('completed', 2); let state: TaskTurnState = 'received';
    try {
      await f.runner.start(f.input, f.target, null, { thread() {}, turn() {}, settled: value => { state = value; } });
      for (let n = 0; n < 100 && state === 'received'; n++) await Bun.sleep(5);
      expect(String(state)).toBe('succeeded');
    } finally { await f.runner.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
  test('creates a durable project-bound thread, verifies exact turn output and releases its writer', async () => {
    const f = fixture('completed'); let thread = ''; let turn = ''; let state: TaskTurnState = 'received';
    try {
      await f.runner.start(f.input, f.target, null, { thread: id => { thread = id; }, turn: id => { turn = id; },
        settled: value => { state = value; } });
      for (let n = 0; n < 100 && state === 'received'; n++) await Bun.sleep(5);
      expect(thread).toBe('fixture-thread'); expect(turn).toBe('fixture-turn'); expect(String(state)).toBe('succeeded');
      const op: TaskOperation = { id: f.input.operationId, instanceId: 'fixture', taskId: f.input.taskId, revision: 1,
        projectId: f.input.projectId, repositoryPath: f.input.repositoryPath, worktreePath: f.input.worktreePath,
        mode: 'review', threadId: thread, turnId: turn, state: 'succeeded', released: false, error: null,
        report: null, createdAt: 1, updatedAt: 2 };
      expect(await f.runner.release(op)).toBe(true);
      await f.runner.guard(f.input, f.target, { ...op, released: true });
      expect(await f.runner.release(op)).toBe(true);
    } finally { await f.runner.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
  test('terminal failure cannot be mistaken for a successful code report', async () => {
    const f = fixture('failed'); let state: TaskTurnState = 'received';
    try {
      await f.runner.start(f.input, f.target, null, { thread() {}, turn() {}, settled: value => { state = value; } });
      for (let n = 0; n < 100 && state === 'received'; n++) await Bun.sleep(5);
      expect(String(state)).toBe('failed');
      expect(() => reportForTurn({ id: 'another', status: 'completed', items: [] }, 'expected')).toThrow();
      expect(() => reportForTurn({ id: 'expected', status: 'failed', items: [] }, 'expected')).toThrow();
    } finally { await f.runner.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
});

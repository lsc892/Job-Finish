// Synthetic SDK boundary tests: the product adapter runs against a controlled Query.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CanUseTool, Query, SDKMessage, SDKResultMessage, query } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { ClaudeExecution } from '../src/runtime/claude';
import { Session } from '../src/core/session';
import { Diagnostics, Signal } from '../src/core/model';
import { binding } from './helpers';

async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('SDK fixture timeout'); await new Promise(r => setTimeout(r, 5)); }
}
function fixture() {
  let owns = true; let failSave = false; let changes = 0;
  const signals: Signal[] = []; const diagnostics = new Diagnostics();
  const session = new Session(binding({ provider: 'claude' }), () => owns,
    () => { if (failSave) throw new Error('Checkpoint disk unavailable'); }, s => signals.push(s), diagnostics, undefined, () => { changes++; });
  const queries: { permission: CanUseTool; emit: (m: SDKMessage) => void; end: () => void; closed: boolean; interrupts: number; interrupt: () => Promise<void> }[] = [];
  const createQuery: typeof query = ({ options }) => {
    const messages: SDKMessage[] = []; let ended = false; let wake = () => {};
    const control = { permission: options!.canUseTool!, emit: (m: SDKMessage) => { messages.push(m); wake(); },
      end: () => { ended = true; wake(); }, closed: false, interrupts: 0, interrupt: async () => {} };
    async function* stream() {
      while (true) {
        if (messages.length) yield messages.shift()!;
        else if (ended) return;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    }
    queries.push(control);
    return Object.assign(stream(), { close: () => { control.closed = true; control.end(); },
      interrupt: async () => { control.interrupts++; await control.interrupt(); } }) as unknown as Query;
  };
  const execution = new ClaudeExecution({ cwd: process.cwd(), maxTurns: 2, session, resume: false, createQuery });
  const result = (): SDKResultMessage => ({ type: 'result', subtype: 'success', is_error: false, session_id: session.binding.sessionId,
    uuid: 'result-1', user_message_uuid: [...session.turns.keys()][0], result: 'SDK_FIXTURE_OK' }) as unknown as SDKResultMessage;
  return { execution, session, signals, diagnostics, queries, result, revoke: () => { owns = false; },
    failSave: () => { failSave = true; }, changes: () => changes };
}
function ask(permission: CanUseTool, controller = new AbortController(), id = 'request-1', tool = 'Bash') {
  return permission(tool, { command: 'echo fixture' }, { signal: controller.signal, requestId: id, toolUseID: `tool-${id}` });
}

for (const scenario of ['question', 'approval']) test(`Captured actual SDK control callback: ${scenario}`, async t => {
  const capture = JSON.parse(readFileSync('tests/fixtures/claude-input-contracts.json', 'utf8')).scenarios.find((s: { scenario: string }) => s.scenario === scenario);
  const request = capture.requests[0];
  const f = fixture(); t.after(() => f.execution.dispose()); await f.execution.run('Replay captured control callback');
  const response = f.queries[0]!.permission(request.tool, request.input, { requestId: request.requestId, toolUseID: request.toolUseID, signal: new AbortController().signal });
  const pending = f.session.requests.get(request.requestId)!;
  assert.equal(pending.kind, scenario); assert.equal(pending.turnId, [...f.session.turns.keys()][0]);
  assert.deepEqual(pending.payload, { toolName: request.tool, input: request.input });
  assert.equal(f.signals[0]!.status, capture.observedStatuses[0]);
  f.execution.respond(request.requestId, { behavior: 'deny', message: 'Captured callback verified without executing tools' });
  assert.equal((await response)?.behavior, 'deny'); assert.equal(f.session.requests.size, 0);
});

test('Claude withdrawal clears waiting state and stale UI responses cannot approve it', async t => {
  const f = fixture(); t.after(() => f.execution.dispose()); await f.execution.run('fixture');
  const q = f.queries[0]!; const abort = new AbortController();
  const response = ask(q.permission, abort);
  assert.equal(f.session.requests.size, 1); assert.equal(f.signals[0]!.status, 'waitingForInput');
  const before = f.changes(); abort.abort();
  assert.equal((await response)?.behavior, 'deny'); assert.equal(f.session.requests.size, 0);
  assert.equal([...f.session.turns.values()][0]!.status, 'running'); assert.ok(f.changes() > before);
  assert.throws(() => f.execution.respond('request-1', { behavior: 'allow', updatedInput: {} }), /no longer/);
  const next = ask(q.permission, undefined, 'request-2', 'AskUserQuestion');
  assert.equal(f.session.requests.get('request-2')!.kind, 'question');
  f.execution.respond('request-2', { behavior: 'allow', updatedInput: { answers: { color: 'Blue' } } });
  assert.deepEqual(await next, { behavior: 'allow', updatedInput: { answers: { color: 'Blue' } } });
});

for (const loss of ['ownership', 'connection'] as const) test(`Claude denies delayed approvals after ${loss} changes`, async t => {
  const f = fixture(); t.after(() => f.execution.dispose()); await f.execution.run('fixture');
  const q = f.queries[0]!; const pending = ask(q.permission);
  if (loss === 'ownership') f.revoke(); else f.session.reconnect('replacement-connection');
  assert.throws(() => f.execution.respond('request-1', { behavior: 'allow', updatedInput: {} }), /no longer/);
  assert.equal((await pending)?.behavior, 'deny');
  assert.equal((await ask(q.permission, undefined, 'late'))?.behavior, 'deny');
  await assert.rejects(() => f.execution.cancel(), /owned/); assert.equal(q.interrupts, 0);
});

test('Claude drains the result tail and rejects callbacks from a previous execution', async t => {
  const f = fixture(); t.after(() => f.execution.dispose()); await f.execution.run('fixture');
  const q = f.queries[0]!; q.emit(f.result()); await until(() => f.signals.length === 1);
  assert.equal(f.signals[0]!.status, 'completed'); assert.equal(q.closed, false);
  assert.equal((await ask(q.permission))?.behavior, 'deny');
  await assert.rejects(() => f.execution.run('too early'), /active/);
  q.end(); await until(() => q.closed); await new Promise(r => setTimeout(r, 0));
  await f.execution.run('next');
  assert.equal((await ask(q.permission, undefined, 'old'))?.behavior, 'deny');
  assert.equal(f.session.requests.size, 0); assert.equal(f.queries.length, 2);
});

test('Claude interrupt acknowledgment cancels once; a result arriving first wins the race', async t => {
  const f = fixture(); t.after(() => f.execution.dispose()); await f.execution.run('fixture');
  const q = f.queries[0]!; const permission = ask(q.permission);
  await f.execution.cancel(); assert.equal((await permission)?.behavior, 'deny');
  assert.equal(f.signals.at(-1)!.status, 'cancelled'); assert.equal(q.closed, false);
  assert.equal((await ask(q.permission, undefined, 'late'))?.behavior, 'deny');
  q.end(); await until(() => q.closed); await new Promise(r => setTimeout(r, 0));
  await f.execution.run('race'); const second = f.queries[1]!;
  let acknowledge!: () => void; second.interrupt = () => new Promise(resolve => { acknowledge = resolve; });
  const cancelling = f.execution.cancel(); second.emit(f.result());
  await until(() => f.signals.at(-1)?.status === 'completed'); acknowledge(); await cancelling;
  assert.equal(f.signals.filter(s => s.status === 'cancelled').length, 1);
  assert.equal(f.diagnostics.entries.some(d => d.message.includes('Conflicting')), false);
});

test('Claude EOF and failed interrupt remain unknown without a fabricated terminal event', async t => {
  const f = fixture(); t.after(() => f.execution.dispose()); await f.execution.run('fixture');
  const q = f.queries[0]!; q.interrupt = async () => { throw new Error('No interrupt acknowledgment'); };
  await assert.rejects(() => f.execution.cancel(), /acknowledgment/); assert.equal(f.signals.length, 0);
  q.end(); await until(() => q.closed);
  assert.equal([...f.session.turns.values()][0]!.status, 'unknown'); assert.equal(f.signals.length, 0);
  await assert.rejects(() => f.execution.run('duplicate'), /unresolved/);
});

test('Claude checkpoint failure denies input and cleans the query without an unhandled rejection', async () => {
  const f = fixture(); await f.execution.run('fixture'); const q = f.queries[0]!; f.failSave();
  assert.equal((await ask(q.permission))?.behavior, 'deny'); assert.equal(f.session.requests.size, 0);
  q.end(); await until(() => q.closed); await new Promise(r => setTimeout(r, 0));
  assert.ok(f.diagnostics.entries.some(d => d.message.includes('disk unavailable')));
});

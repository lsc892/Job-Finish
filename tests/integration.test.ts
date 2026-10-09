import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodexExecution, codexApprovalResponse } from '../src/runtime/codex';
import { Session } from '../src/core/session';
import { Checkpoint, Diagnostics, Signal } from '../src/core/model';
import { RpcMessage } from '../src/runtime/transport';
import { binding } from './helpers';

async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise(r => setTimeout(r, 10)); }
}
function execution(checkpoint?: Checkpoint) {
  const diagnostics = new Diagnostics(); const signals: Signal[] = []; let owned = true;
  const runtime = new CodexExecution({ cwd: process.cwd(), executable: resolve('tests/fixtures/app-server.cjs'), diagnostic: diagnostics,
    createSession: (sessionId, connectionId) => new Session(binding({ sessionId, connectionId }), () => owned, () => {}, s => signals.push(s), diagnostics, checkpoint) });
  return { runtime, diagnostics, signals, revoke: () => { owned = false; } };
}
test('Owned execution: initialize/start, event-before-response, Unicode body, duplicate terminal, recovery baseline', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open();
  await f.runtime.run('완료😀'); await until(() => f.signals.length === 1);
  assert.equal(f.signals[0]!.text, '완료😀'); assert.equal(f.signals[0]!.status, 'completed');
  const previous = f.runtime.session!.binding.connectionId;
  await f.runtime.reconnect(); assert.notEqual(f.runtime.session!.binding.connectionId, previous); assert.equal(f.signals.length, 1);
});
for (const prompt of ['approval', 'question']) test(`Owned ${prompt} relays the original request and clears waiting state`, async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open(); await f.runtime.run(prompt);
  await until(() => f.runtime.session!.requests.size === 1);
  assert.equal(f.signals[0]!.status, 'waitingForInput');
  const request = [...f.runtime.session!.requests.values()][0]!;
  f.runtime.respond(request.id, prompt === 'approval' ? { decision: 'decline' } : { answers: { q: { answers: ['Blue'] } } });
  await until(() => f.signals.length === 2); assert.equal(f.runtime.session!.requests.size, 0); assert.equal(f.signals[1]!.status, 'completed');
});
test('Explicit interrupt waits for terminal event; unexpected EOF stays unknown across automatic reconnect', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open(); await f.runtime.run('wait'); await f.runtime.cancel();
  await until(() => f.signals.length === 1); assert.equal(f.signals[0]!.status, 'cancelled');
  await f.runtime.run('disconnect'); await until(() => [...f.runtime.session!.turns.values()].some(t => t.status === 'unknown'));
  const connection = f.runtime.session!.binding.connectionId;
  await until(() => f.runtime.session!.binding.connectionId !== connection);
  await f.runtime.reconnect();
  assert.equal(f.signals.length, 1); assert.equal([...f.runtime.session!.turns.values()][0]!.status, 'unknown');
  await assert.rejects(() => f.runtime.run('duplicate'), /unresolved/);
});
test('Rejected start is an error of the request, without inventing a provider turn', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open();
  await assert.rejects(() => f.runtime.run('reject-start'), /Start rejected/);
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.scope, 'startRequest'); assert.equal(f.signals[0]!.turnId, '');
  assert.equal(f.signals[0]!.status, 'error'); assert.equal(f.runtime.session!.turns.size, 0);
});

test('Large stored thread resumes with bounded metadata pages and retrieves a specific result', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open('history-large');
  assert.equal(f.signals.length, 0); assert.equal(f.runtime.session!.completed.size, 512);
  assert.equal(f.runtime.session!.completed.has('old-599'), true); assert.equal(f.runtime.session!.completed.has('old-0'), false);
  assert.equal(await f.runtime.readResult('old-599'), 'x'.repeat(4096) + '599');
  assert.ok(f.diagnostics.entries.some(d => d.message.includes('latest 512')));
  await f.runtime.run('after-history'); await until(() => f.signals.length === 1);
  assert.equal(f.signals[0]!.text, 'after-history');
});

for (const pending of [false, true]) test(`Paged recovery binds ${pending ? 'pending start' : 'tracked turn'} and emits only its final body`, async t => {
  const f = execution({ version: 1, completed: [], turns: pending ? [] : [{ id: 'recovered-turn', status: 'running', text: 'stale', truncated: false }], ...(pending ? { pendingStart: 'recover-request' } : {}) });
  t.after(() => f.runtime.dispose()); await f.runtime.open('history-recovery');
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.status, 'completed');
  assert.ok(f.signals[0]!.text.startsWith('RECOVERED_')); assert.equal(f.signals[0]!.truncated, true);
  assert.equal(f.runtime.session!.pendingStart, undefined);
  assert.equal(await f.runtime.readResult('recovered-turn'), 'RECOVERED_' + 'y'.repeat(20_000));
  await f.runtime.reconnect(); assert.equal(f.signals.length, 1);
});

test('A start request absent from paged history stays unresolved and cannot start another execution', async t => {
  const f = execution({ version: 1, completed: [], turns: [], pendingStart: 'not-in-history' });
  t.after(() => f.runtime.dispose()); await f.runtime.open('history-recovery');
  assert.equal(f.runtime.session!.pendingStart, 'not-in-history'); assert.equal(f.signals.length, 0);
  await assert.rejects(() => f.runtime.run('duplicate'), /unresolved/);
});

test('An incomplete stored turn is unknown when the resumed runtime is idle', async t => {
  const f = execution({ version: 1, completed: [], turns: [{ id: 'recovered-turn', status: 'running', text: '', truncated: false }] });
  t.after(() => f.runtime.dispose()); await f.runtime.open('history-incomplete');
  assert.equal(f.runtime.session!.turns.get('recovered-turn')!.status, 'unknown'); assert.equal(f.signals.length, 0);
  await assert.rejects(() => f.runtime.run('duplicate'), /unresolved/);
});

for (const allow of [false, true]) test(`Permissions approval ${allow ? 'grants only requested paths for this turn' : 'denies all permissions'}`, async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open(); await f.runtime.run('permissions');
  await until(() => f.runtime.session!.requests.size === 1);
  const request = [...f.runtime.session!.requests.values()][0]!;
  const response = codexApprovalResponse(request.payload as RpcMessage, allow);
  f.runtime.respond(request.id, response); await until(() => f.signals.length === 2);
  assert.deepEqual(JSON.parse(f.signals[1]!.text), { scope: 'turn', permissions: allow ? { fileSystem: { read: null, write: ['C:\\fixture'] } } : {} });
  assert.equal(f.runtime.session!.requests.size, 0);
});

test('Codex refuses controls after losing ownership', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open(); await f.runtime.run('approval');
  await until(() => f.runtime.session!.requests.size === 1); const request = [...f.runtime.session!.requests.values()][0]!;
  f.revoke();
  assert.throws(() => f.runtime.respond(request.id, { decision: 'accept' }), /no longer/);
  await assert.rejects(() => f.runtime.cancel(), /owned/);
  await assert.rejects(() => f.runtime.reconnect(), /ownership lost/);
  assert.equal(f.signals.filter(s => s.status !== 'waitingForInput').length, 0);
});

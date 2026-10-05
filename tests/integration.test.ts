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
test('Owned execution: initialize/start, event-before-response, Unicode body, duplicate terminal', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open();
  await f.runtime.run('완료😀'); await until(() => f.signals.length === 1);
  assert.equal(f.signals[0]!.text, '완료😀'); assert.equal(f.signals[0]!.status, 'completed');
});
for (const prompt of ['approval', 'question']) test(`Owned ${prompt} relays the original request and clears waiting state`, async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open(); await f.runtime.run(prompt);
  await until(() => f.runtime.session!.requests.size === 1);
  assert.equal(f.signals[0]!.status, 'waitingForInput');
  const request = [...f.runtime.session!.requests.values()][0]!;
  f.runtime.respond(request.id, prompt === 'approval' ? { decision: 'decline' } : { answers: { q: { answers: ['Blue'] } } });
  await until(() => f.signals.length === 2); assert.equal(f.runtime.session!.requests.size, 0); assert.equal(f.signals[1]!.status, 'completed');
});
test('Explicit interrupt waits for terminal event; unexpected EOF stays unknown', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open(); await f.runtime.run('wait'); await f.runtime.cancel();
  await until(() => f.signals.length === 1); assert.equal(f.signals[0]!.status, 'cancelled');
  await f.runtime.run('disconnect'); await until(() => [...f.runtime.session!.turns.values()].some(t => t.status === 'unknown'));
  await assert.rejects(() => f.runtime.run('duplicate'), /Reconnect/);
});
test('Rejected start is an error of the request, without inventing a provider turn', async t => {
  const f = execution(); t.after(() => f.runtime.dispose()); await f.runtime.open();
  await assert.rejects(() => f.runtime.run('reject-start'), /Start rejected/);
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.scope, 'startRequest'); assert.equal(f.signals[0]!.turnId, '');
  assert.equal(f.signals[0]!.status, 'error'); assert.equal(f.runtime.session!.turns.size, 0);
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
  assert.equal(f.signals.filter(s => s.status !== 'waitingForInput').length, 0);
});

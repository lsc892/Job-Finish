import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodexExecution } from '../src/runtime/codex';
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

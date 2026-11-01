// Codex 이력 대조 중 소유권·연결 상실과 충돌 결과·미관찰 실행 처리를 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import type { Thread } from '../src/protocol/v2/Thread';
import { CodexAdapter } from '../src/runtime/codex/adapter';
import { CodexReconciliation } from '../src/runtime/codex/reconciliation';
import type { StdioRpc } from '../src/runtime/transport';
import { fixture } from './helpers';

const thread = (active = false) => ({ id: 'thread-A', status: { type: active ? 'active' : 'idle' } }) as Thread;

for (const lost of ['connection', 'ownership']) test(`History cannot change a session after losing ${lost} during a lookup`, async () => {
  const f = fixture();
  f.session.start('tracked', 'connection-1');
  let current = true;
  let reply!: (value: unknown) => void;
  const pending = new Promise(resolve => { reply = resolve; });
  const rpc = { connectionId: 'connection-1', connected: true, request: () => pending } as unknown as StdioRpc;
  const reconciliation = new CodexReconciliation(new CodexAdapter(f.session), f.diagnostics, () => current);
  const result = assert.rejects(reconciliation.reconcile(thread(), rpc), /connection or ownership changed/);
  if (lost === 'connection') current = false;
  else f.revoke();
  reply({ data: [{ id: 'tracked', status: 'completed', items: [] }], nextCursor: null });
  await result;
  assert.equal(f.session.turns.get('tracked')?.status, 'running');
  assert.equal(f.session.completed.size, 0);
  assert.equal(f.signals.length, 0);
});

test('Recovery refuses an unobserved active execution even when history omits its turn', async () => {
  for (const turns of [[{ id: 'unobserved', status: 'inProgress', items: [] }], []]) {
    const f = fixture();
    const rpc = { connectionId: 'connection-1', connected: true,
      request: async () => ({ data: turns, nextCursor: null }) } as unknown as StdioRpc;
    const reconciliation = new CodexReconciliation(new CodexAdapter(f.session), f.diagnostics, () => true);
    await assert.rejects(reconciliation.reconcile(thread(true), rpc), /unobserved active execution/);
    assert.equal(f.session.turns.size, 0);
    assert.equal(f.session.completed.size, 0);
    assert.equal(f.signals.length, 0);
  }
});

test('Conflicting results share one read-only lookup and never create or redeliver a turn', async () => {
  const f = fixture();
  f.session.start('completed', 'connection-1');
  f.session.body('completed', 'original', 'connection-1');
  f.session.finish('completed', 'completed', 'connection-1');
  const methods: string[] = [];
  let reply!: (value: unknown) => void;
  const pending = new Promise(resolve => { reply = resolve; });
  const rpc = { connectionId: 'connection-1', connected: true, request: async (method: string) => {
    methods.push(method);
    if (method === 'thread/read') return pending;
    return { data: [{ id: 'completed', status: 'completed', items: [] }], nextCursor: null };
  } } as unknown as StdioRpc;
  const reconciliation = new CodexReconciliation(new CodexAdapter(f.session), f.diagnostics, () => true);
  const message = { method: 'turn/completed', params: { threadId: 'thread-A', turn: { id: 'completed', status: 'failed' } } };
  reconciliation.reconcileConflictingResult(message, rpc);
  reconciliation.reconcileConflictingResult(message, rpc);
  assert.deepEqual(methods, ['thread/read']);
  reply({ thread: thread() });
  await nextTick();
  assert.deepEqual(methods, ['thread/read', 'thread/turns/list']);
  assert.equal(f.session.turns.size, 0);
  assert.equal(f.signals.length, 1);
  assert.equal(f.signals[0]?.text, 'original');
  assert.equal(f.session.completed.get('completed'), 'completed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, codexStatus } from '../src/runtime/codex';
import { acceptClaudeResult } from '../src/runtime/claude';
import { Session } from '../src/core/session';
import { boundedText, Diagnostics, LIMITS, Signal, toastText } from '../src/core/model';
import { binding, fixture } from './helpers';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

test('Unknown protocol status cannot be mistaken for a terminal status', () => {
  for (const status of ['toString', 'constructor', 'inProgress', 'unknown', '']) assert.equal(codexStatus(status), undefined);
});

for (const [providerStatus, status] of [['completed', 'completed'], ['failed', 'error'], ['interrupted', 'cancelled']]) {
  test(`Codex ${providerStatus}: body alone never terminates, replay notifies once`, () => {
    const f = fixture(); const adapter = new CodexAdapter(f.session);
    adapter.handle({ method: 'turn/started', params: { threadId: 'thread-A', turn: { id: 't', status: 'inProgress' } } }, 'connection-1', true);
    adapter.handle({ method: 'item/completed', params: { threadId: 'thread-A', turnId: 't', item: { type: 'agentMessage', text: '완료한 결과', phase: 'final_answer' } } }, 'connection-1');
    assert.equal(f.signals.length, 0);
    const end = { method: 'turn/completed', params: { threadId: 'thread-A', turn: { id: 't', status: providerStatus, items: [] } } };
    adapter.handle(end, 'connection-1'); adapter.handle(end, 'connection-1');
    assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.status, status); assert.equal(f.signals[0]!.text, '완료한 결과');
    assert.equal(f.session.turns.size, 0);
  });
}
test('Interleaved turns/sessions never mix bodies; missing body does not reuse prior turn', () => {
  const a = fixture(); const b = fixture({ sessionId: 'thread-B', windowInstanceId: 'window-B' });
  a.session.start('a1', 'connection-1'); a.session.start('a2', 'connection-1'); b.session.start('b1', 'connection-1');
  a.session.body('a1', 'A', 'connection-1'); b.session.body('b1', 'B', 'connection-1');
  a.session.finish('a2', 'completed', 'connection-1'); b.session.finish('b1', 'error', 'connection-1'); a.session.finish('a1', 'completed', 'connection-1');
  assert.deepEqual(a.signals.map(s => s.text), ['', 'A']); assert.equal(b.signals[0]!.text, 'B'); assert.equal(b.signals[0]!.windowInstanceId, 'window-B');
});
test('Disconnect, checkpoint restore and re-delivery preserve identity and only recover tracked turns', () => {
  const f = fixture(); f.session.start('old', 'connection-1'); f.session.finish('old', 'completed', 'connection-1');
  f.session.start('lost', 'connection-1'); f.session.disconnected('EOF');
  assert.equal(f.session.turns.get('lost')!.status, 'unknown');
  const signals: Signal[] = [];
  const restored = new Session(binding({ connectionId: 'connection-2', windowInstanceId: 'new-window' }), () => true, () => {}, s => signals.push(s), new Diagnostics(), f.session.checkpoint());
  restored.finish('lost', 'completed', 'connection-1'); assert.equal(signals.length, 0);
  restored.finish('old', 'completed', 'connection-2'); restored.finish('history', 'completed', 'connection-2');
  restored.body('lost', 'Recovered', 'connection-2'); restored.finish('lost', 'completed', 'connection-2'); restored.finish('lost', 'completed', 'connection-2');
  assert.equal(signals.length, 1); assert.equal(signals[0]!.text, 'Recovered'); assert.equal(signals[0]!.windowInstanceId, 'new-window');
});
test('Disconnect before turn ID leaves a durable unresolved start request', () => {
  const f = fixture(); f.session.beginStart('request-1', 'connection-1'); f.session.disconnected('EOF before turn/start response');
  const restored = new Session(binding({ connectionId: 'connection-2' }), () => true, () => {}, () => {}, new Diagnostics(), f.session.checkpoint());
  assert.equal(restored.pendingStart, 'request-1'); assert.throws(() => restored.beginStart('duplicate', 'connection-2'), /unresolved/);
  restored.start('confirmed-turn', 'connection-2'); assert.equal(restored.pendingStart, undefined); assert.equal(restored.turns.size, 1);
});
test('Conflicting terminal states diagnose without double notification', () => {
  const f = fixture(); f.session.start('t', 'connection-1'); f.session.finish('t', 'completed', 'connection-1'); f.session.finish('t', 'error', 'connection-1');
  assert.equal(f.signals.length, 1); assert.match(f.diagnostics.entries[0]!.message, /Conflicting/);
});
test('Requests deduplicate, preserve request scope and clear on response/terminal/disconnect', () => {
  const f = fixture(); f.session.start('t', 'connection-1');
  const req = { id: '1', turnId: 't', connectionId: 'connection-1', kind: 'approval' as const, title: 'Allow?', payload: {} };
  f.session.waiting(req); f.session.waiting(req); assert.equal(f.signals.length, 1);
  f.session.waiting({ ...req, id: '2' }); f.session.resolve('1', 'connection-1'); assert.equal(f.session.turns.get('t')!.status, 'waitingForInput');
  f.session.resolve('2', 'connection-1'); assert.equal(f.session.turns.get('t')!.status, 'running');
  f.session.waiting(req); assert.equal(f.signals.length, 2);
  f.session.reconnect('connection-2'); f.session.waiting({ ...req, connectionId: 'connection-2' }); assert.equal(f.signals.length, 3);
  f.session.finish('t', 'cancelled', 'connection-2'); assert.equal(f.session.requests.size, 0);
});
test('Losing ownership suppresses both mutation and notification', () => {
  const f = fixture(); f.session.start('t', 'connection-1'); f.revoke(); f.session.finish('t', 'completed', 'connection-1'); assert.equal(f.signals.length, 0);
});
test('Bounded keys, active turns, diagnostics and UTF-8 result storage', () => {
  const f = fixture();
  for (let i = 0; i < 600; i++) { f.session.start(`${i}`, 'connection-1'); f.session.finish(`${i}`, 'completed', 'connection-1'); f.diagnostics.add(i); }
  assert.equal(f.session.completed.size, LIMITS.dedup); assert.equal(f.diagnostics.entries.length, LIMITS.diagnostics);
  f.session.finish('0', 'completed', 'connection-1'); assert.equal(f.signals.length, 600);
  for (let i = 0; i < LIMITS.turns; i++) f.session.start(`pending-${i}`, 'connection-1');
  assert.throws(() => f.session.start('overflow', 'connection-1'), /limit/);
  const text = boundedText('😀한글'.repeat(10_000)); assert.ok(text.truncated); assert.ok(Buffer.byteLength(text.text) <= LIMITS.textBytes); assert.ok(!text.text.includes('�'));
  assert.equal(Array.from(toastText('😀'.repeat(181))).length, 180);
});
for (const [subtype, is_error, status] of [['success', false, 'completed'], ['success', true, 'error'], ['error_max_turns', true, 'error'], ['error_during_execution', true, 'error']]) {
  test(`Claude ${subtype}/${is_error} maps to ${status}`, () => {
    const f = fixture({ provider: 'claude' }); f.session.start('request', 'connection-1');
    const result = { type: 'result', subtype, is_error, uuid: 'result-1', session_id: 'thread-A', result: '본문', errors: ['API failure'] } as unknown as SDKResultMessage;
    acceptClaudeResult(f.session, 'request', result, 'connection-1'); acceptClaudeResult(f.session, 'request', result, 'connection-1');
    assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.status, status);
    if (subtype === 'error_max_turns') assert.match(f.signals[0]!.detail!, /not account quota/);
  });
}
test('Claude mismatched session or result request is rejected', () => {
  const f = fixture({ provider: 'claude' }); f.session.start('request', 'connection-1');
  assert.throws(() => acceptClaudeResult(f.session, 'request', { session_id: 'another', uuid: 'result' } as unknown as SDKResultMessage, 'connection-1'), /identity/);
  assert.throws(() => acceptClaudeResult(f.session, 'request', { session_id: 'thread-A', uuid: 'result', user_message_uuid: 'other' } as unknown as SDKResultMessage, 'connection-1'), /bound/);
});

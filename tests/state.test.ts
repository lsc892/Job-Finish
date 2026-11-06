// 관찰 세션의 격리·중복 제거·입력 상태·보관 상한을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedText, Diagnostics, LIMITS, toastText } from '../src/core/model';
import { fixture } from './helpers';

test('Diagnostic errors reach the log sink with correlation, bounded messages and stack traces', () => {
  const logged: Record<string, unknown>[] = [];
  const diagnostics = new Diagnostics(entry => logged.push(entry));
  diagnostics.add(new Error('helper failed'), { notificationId: 'notification', stage: 'notification-delivery' });
  assert.equal(logged[0]!.event, 'diagnostic.error'); assert.equal(logged[0]!.notificationId, 'notification');
  assert.match(String(logged[0]!.stack), /helper failed/);
  assert.equal(diagnostics.entries[0]!.message, 'Error: helper failed');
  for (let i = 0; i < LIMITS.diagnostics + 1; i++) diagnostics.add('한'.repeat(2000));
  assert.equal(diagnostics.entries.length, LIMITS.diagnostics); assert.equal(diagnostics.events.length, LIMITS.diagnostics);
  assert.ok(Buffer.byteLength(String(logged.at(-1)!.message)) <= 2048);
  assert.equal(logged.length, LIMITS.diagnostics + 2, 'the file/output sink retains errors beyond the in-memory ring');
});

test('Interleaved turns and windows never mix response bodies', () => {
  const a = fixture(); const b = fixture({ sessionId: 'thread-B', windowInstanceId: 'window-B' });
  a.session.start('a1', 'connection-1'); a.session.start('a2', 'connection-1'); b.session.start('b1', 'connection-1');
  a.session.body('a1', 'A', 'connection-1'); b.session.body('b1', 'B', 'connection-1');
  a.session.finish('a2', 'completed', 'connection-1'); b.session.finish('b1', 'error', 'connection-1'); a.session.finish('a1', 'completed', 'connection-1');
  assert.deepEqual(a.signals.map(s => s.text), ['', 'A']); assert.equal(b.signals[0]!.text, 'B'); assert.equal(b.signals[0]!.windowInstanceId, 'window-B');
});

test('Conflicting terminal states diagnose without double notification', () => {
  const f = fixture(); f.session.start('t', 'connection-1'); f.session.finish('t', 'completed', 'connection-1'); f.session.finish('t', 'error', 'connection-1');
  assert.equal(f.signals.length, 1); assert.match(f.diagnostics.entries[0]!.message, /Conflicting/);
});

test('Requests deduplicate, retain only turn identity and resolve independently', () => {
  const f = fixture(); f.session.start('t', 'connection-1');
  const req = { id: '1', turnId: 't', connectionId: 'connection-1', title: 'Allow?'.repeat(10000) };
  assert.throws(() => f.session.waiting({ ...req, id: 'x'.repeat(1025) }), /identifier exceeds/);
  assert.equal(f.session.requests.size, 0);
  f.session.waiting(req); f.session.waiting(req);
  assert.equal(f.signals.length, 1);
  assert.deepEqual(f.session.requests.get('1'), { turnId: 't' });
  assert.equal(f.signals[0]!.truncated, true);
  assert.ok(Buffer.byteLength(f.signals[0]!.text) <= LIMITS.textBytes);
  f.session.waiting({ ...req, id: '2' }); f.session.resolve('1', 'connection-1');
  assert.equal(f.session.turns.get('t')!.status, 'waitingForInput');
  f.session.resolve('2', 'connection-1'); assert.equal(f.session.turns.get('t')!.status, 'running');
  f.session.waiting(req); assert.equal(f.signals.length, 2);
  f.session.waiting({ ...req, id: '3' }); f.session.finish('t', 'cancelled', 'connection-1');
  assert.equal(f.session.requests.size, 0);
});

test('Events from another connection cannot mutate or notify', () => {
  const f = fixture(); f.session.start('t', 'connection-1');
  f.session.setTitle('stale', 'other'); f.session.body('t', 'stale', 'other');
  f.session.waiting({ id: 'x', turnId: 't', title: 'stale', connectionId: 'other' });
  f.session.notifyQuestion('t', 'x', 'stale', 'other'); f.session.finish('t', 'completed', 'other');
  assert.equal(f.signals.length, 0); assert.equal(f.session.sessionTitle, undefined);
  assert.equal(f.session.turns.get('t')!.text, ''); assert.equal(f.session.requests.size, 0);
});

test('Async questions notify once per turn/item without changing execution, final body or pending requests', () => {
  const f = fixture(); f.session.start('t', 'connection-1'); f.session.body('t', 'final response', 'connection-1');
  f.session.waiting({ id: 'approval', turnId: 't', connectionId: 'connection-1', title: 'Allow?' });
  const before = structuredClone([...f.session.turns]);
  f.session.notifyQuestion('t', 'question', '첫 질문\n두 번째 질문', 'connection-1');
  f.session.notifyQuestion('t', 'question', 'duplicate', 'connection-1');
  assert.equal(f.signals.length, 2); assert.equal(f.signals[1]!.kind, 'asyncQuestion');
  assert.equal(f.signals[1]!.requestId, undefined); assert.deepEqual([...f.session.turns], before);
  assert.deepEqual([...f.session.requests.keys()], ['approval']);
  f.session.resolve('approval', 'connection-1'); f.session.finish('t', 'completed', 'connection-1');
  f.session.notifyQuestion('t', 'late', 'late question', 'connection-1');
  assert.equal(f.signals.length, 3); assert.equal(f.signals[2]!.text, 'final response');
  f.session.start('next', 'connection-1'); f.session.notifyQuestion('next', 'question', 'next question', 'connection-1');
  assert.equal(f.signals.length, 4);
});

test('Bounded completed IDs, active turns, requests, diagnostics and UTF-8 result storage', () => {
  const f = fixture();
  for (let i = 0; i < 600; i++) { f.session.start(`${i}`, 'connection-1'); f.session.finish(`${i}`, 'completed', 'connection-1'); f.diagnostics.add(i); }
  assert.equal(f.session.completed.size, LIMITS.dedup); assert.equal(f.diagnostics.entries.length, LIMITS.diagnostics);
  f.session.finish('0', 'completed', 'connection-1'); assert.equal(f.signals.length, 600);
  for (let i = 0; i < LIMITS.turns; i++) f.session.start(`pending-${i}`, 'connection-1');
  assert.throws(() => f.session.start('overflow', 'connection-1'), /limit/);
  for (let i = 0; i < LIMITS.requests; i++) f.session.waiting({ id: `${i}`, turnId: 'pending-0', title: 'Allow?', connectionId: 'connection-1' });
  assert.throws(() => f.session.waiting({ id: 'overflow', turnId: 'pending-0', title: 'Allow?', connectionId: 'connection-1' }), /limit/);
  const text = boundedText('😀한글'.repeat(10000)); assert.ok(text.truncated); assert.ok(Buffer.byteLength(text.text) <= LIMITS.textBytes); assert.ok(!text.text.includes('�'));
  assert.equal(Array.from(toastText('😀'.repeat(2000))).length, 1024);
});

test('Toast previews reclaim blank lines and retain enough text for the native layout', () => {
  assert.equal(toastText('  완료\r\n\r\n\t 다음 내용\u0000  '), '완료 다음 내용');
  const text = '가나다😀'.repeat(100);
  assert.equal(toastText(text), text, 'do not discard usable text at the former 180-character limit');
  const long = toastText('😀'.repeat(2000));
  assert.ok(long.endsWith('…')); assert.ok(!long.includes('�'));
});

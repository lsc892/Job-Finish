import test from 'node:test';
import assert from 'node:assert/strict';
import { inputQuestionText, notificationTitle } from '../src/core/input';
import { fixture } from './helpers';

test('Question previews show question and numbered choice labels across provider schemas', () => {
  assert.equal(inputQuestionText([{ question: '어느 색으로 할까요?', options: [{ label: '파랑' }, { label: '초록' }, { label: '빨강' }] }], 'Answer needed'),
    '어느 색으로 할까요?\n1. 파랑\n2. 초록\n3. 빨강');
  assert.equal(inputQuestionText([{ title: 'Select a plan', options: ['Small', 'Large'] }], 'Answer needed'), 'Select a plan\n1. Small\n2. Large');
  assert.equal(inputQuestionText([{ question: 'Pick', options: [null, 'A', {}, { label: 'B' }] }], 'Fallback'), 'Pick\n1. A\n2. B');
  assert.equal(inputQuestionText([null, { title: '', options: ['Secret'] }, { question: 'Question', options: [null, {}, 123] }], 'Fallback'), 'Question');
  assert.equal(inputQuestionText({ privateToken: 'never render opaque data' }, 'Fallback'), 'Fallback');
  const preview = inputQuestionText([{ question: '한글😀'.repeat(5000), options: ['Yes'] }], 'Fallback');
  assert.ok(Buffer.byteLength(preview) < 16 * 1024); assert.ok(!preview.includes('�'));
});

test('Async waiting notices require a live owned turn and never invent a pending response', () => {
  const f = fixture();
  f.session.notifyWaitingForInput('history', 'connection-1', 'Choose', 'item');
  f.session.start('turn', 'connection-1', '확장 알림 수정');
  f.session.notifyWaitingForInput('turn', 'stale-connection', 'Choose', 'item');
  assert.equal(f.signals.length, 0);
  f.session.notifyWaitingForInput('turn', 'connection-1', '어느 색?\n파랑 / 초록', 'item');
  f.session.notifyWaitingForInput('turn', 'connection-1', 'Choose', 'item');
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.inputKind, 'question');
  assert.equal(f.signals[0]!.title, '확장 알림 수정');
  assert.equal(f.signals[0]!.requestId, undefined); assert.equal(f.session.requests.size, 0);
  assert.equal(f.session.turns.get('turn')!.status, 'waitingForInput');
  assert.match(notificationTitle(f.signals[0]!), /Codex · Answer needed/);
  f.session.clearInputNotice('turn', 'connection-1');
  assert.equal(f.session.turns.get('turn')!.status, 'running');
  f.session.notifyWaitingForInput('turn', 'connection-1', 'Replay', 'item');
  assert.equal(f.signals.length, 1);
  f.revoke(); f.session.notifyWaitingForInput('turn', 'connection-1', 'Unowned', 'new');
  assert.equal(f.signals.length, 1);
});

test('Status and actual question overlap retains pending request with one notice', () => {
  const f = fixture(); f.session.start('turn', 'connection-1'); f.session.setTitle('설치 도구 개선', 'connection-1');
  f.session.notifyWaitingForInput('turn', 'connection-1', 'Answer needed', 'status:1');
  f.session.waiting({ id: 'rpc', turnId: 'turn', connectionId: 'connection-1', kind: 'question', title: 'Choose A or B', payload: null });
  assert.equal(f.signals.length, 1); assert.equal(f.session.requests.size, 1);
  f.session.clearInputNotice('turn', 'connection-1');
  assert.equal(f.session.turns.get('turn')!.status, 'waitingForInput');
  f.session.resolve('rpc', 'connection-1'); assert.equal(f.session.turns.get('turn')!.status, 'running');
  f.session.notifyWaitingForInput('turn', 'connection-1', 'Approve next action', 'status:2', 'approval');
  assert.equal(f.signals.length, 2); assert.match(notificationTitle(f.signals[1]!), /Approval needed/);
  assert.equal(f.signals[1]!.title, '설치 도구 개선');
  f.session.finish('turn', 'completed', 'connection-1');
  f.session.notifyWaitingForInput('turn', 'connection-1', 'Replay', 'status:3');
  assert.equal(f.signals.length, 3); assert.equal(f.signals[2]!.status, 'completed');
});

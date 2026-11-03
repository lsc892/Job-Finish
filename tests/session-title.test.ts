// 세션 제목의 관찰·이름 변경·대체·복구와 토스트 표시를 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics, Provider, sessionTitleText, Signal } from '../src/core/model';
import { notificationTitle } from '../src/core/notifications';
import { AgentEventRouter } from '../src/runtime/event-router';
import { binding, fixture } from './helpers';

function observed(provider: Provider = 'codex') {
  const signals: Signal[] = [];
  const router = new AgentEventRouter(provider, '18e97d8f-window', 'runtime', signal => signals.push(signal), new Diagnostics());
  return { router, signals };
}
function complete(router: AgentEventRouter, threadId: string, turnId = 'turn') {
  router.incoming({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
}

test('Toast titles use a normalized session title and never substitute a window or session ID', () => {
  const signal: Signal = { ...binding({ windowInstanceId: '18e97d8f-window' }), notificationId: 'n', turnId: 't',
    status: 'completed', text: 'AI 응답', truncated: false, at: '', sessionTitle: '  데이터\r\n 집계\t수정😀\0  ' };
  assert.equal(notificationTitle(signal), 'codex · completed · 데이터 집계 수정😀');
  for (const title of [undefined, '', ' \t\n']) assert.equal(notificationTitle({ ...signal, sessionTitle: title }), 'codex · completed');
  const long = sessionTitleText('😀'.repeat(101))!;
  assert.equal(Array.from(long).length, 100);
  assert.equal(long, '😀'.repeat(99) + '…');
  assert.equal(sessionTitleText({ name: 'invalid' }), undefined);
});

test('Session titles keep the first prompt, prefer runtime names and reject stale connections', () => {
  const f = fixture(); f.session.setTitle('첫 요청', 'connection-1', true); f.session.setTitle('후속 요청', 'connection-1', true);
  assert.equal(f.session.sessionTitle, '첫 요청');
  f.session.setTitle('저장된 제목', 'connection-1'); f.session.setTitle('오래된 연결', 'stale');
  f.session.start('turn', 'connection-1'); f.session.finish('turn', 'completed', 'connection-1');
  assert.equal(f.signals[0]!.sessionTitle, '저장된 제목');
});

for (const source of ['started', 'response', 'list']) test(`Observed Codex ${source} metadata supplies titles without replaying history`, () => {
  const f = observed();
  const thread = { id: 'thread', name: '저장된 세션 제목', preview: '첫 요청', turns: [{ id: 'old', status: 'completed' }] };
  f.router.incoming(source === 'started' ? { method: 'thread/started', params: { thread } }
    : { id: 1, result: source === 'list' ? { data: [thread] } : { thread } });
  assert.equal(f.signals.length, 0);
  assert.equal(f.router.snapshot().activeTurns, 0);
  complete(f.router, 'thread');
  assert.equal(f.signals[0]!.sessionTitle, '저장된 세션 제목');
  assert.equal(notificationTitle(f.signals[0]!), 'codex · completed · 저장된 세션 제목');
});

test('Observed Codex first prompts are fallbacks; renames and interleaved sessions remain separate', () => {
  const f = observed();
  const prompt = (threadId: string, text: string) => f.router.outgoing({ method: 'turn/start', params: { threadId, input: [
    { type: 'image', url: 'ignored-image' }, { type: 'text', text },
  ] } });
  prompt('a', 'A의 첫 요청'); prompt('b', 'B의 첫 요청');
  complete(f.router, 'a', 'a1');
  prompt('a', 'A의 후속 요청'); complete(f.router, 'a', 'a2');
  f.router.incoming({ method: 'thread/name/updated', params: { threadId: 'a', threadName: 'A의 새 제목' } });
  complete(f.router, 'b', 'b1'); complete(f.router, 'a', 'a3');
  assert.deepEqual(f.signals.map(signal => signal.sessionTitle), ['A의 첫 요청', 'A의 첫 요청', 'B의 첫 요청', 'A의 새 제목']);
  assert.equal(f.signals[0]!.sessionTitle, 'A의 첫 요청', 'old signals retain their title at delivery');
});

test('History previews identify an existing Codex session and excluded threads never notify', () => {
  const f = observed();
  f.router.incoming({ id: 1, result: { thread: { id: 'existing', name: null, preview: '기존 첫 요청' } } });
  complete(f.router, 'existing');
  assert.equal(f.signals[0]!.sessionTitle, '기존 첫 요청');
  for (const thread of [{ id: 'ephemeral', ephemeral: true }, { id: 'subagent', source: { subAgent: {} } }]) {
    f.router.incoming({ method: 'thread/started', params: { thread: { ...thread, name: '제외할 제목' } } });
    complete(f.router, thread.id);
  }
  assert.equal(f.signals.length, 1);
});

for (const content of ['Claude 첫 요청', [{ type: 'image', source: {} }, { type: 'text', text: 'Claude 첫 요청' }]])
test(`Observed Claude ${typeof content === 'string' ? 'text' : 'blocks'} uses the first prompt after init`, () => {
  const f = observed('claude');
  f.router.outgoing({ type: 'user', uuid: 'first', message: { role: 'user', content } });
  f.router.incoming({ type: 'system', subtype: 'init', session_id: 'claude-session' });
  const result = (uuid: string) => ({ type: 'result', uuid: `result-${uuid}`, session_id: 'claude-session',
    user_message_uuid: uuid, subtype: 'success', is_error: false, result: '답변' });
  f.router.incoming(result('first'));
  f.router.outgoing({ type: 'user', uuid: 'second', session_id: 'claude-session', message: { content: '후속 요청' } });
  f.router.incoming(result('second'));
  assert.deepEqual(f.signals.map(signal => signal.sessionTitle), ['Claude 첫 요청', 'Claude 첫 요청']);
});

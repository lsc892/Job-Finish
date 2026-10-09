import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AgentEventRouter } from '../src/runtime/event-router';
import { Diagnostics, Provider, Signal } from '../src/core/model';

const fixture = (name: string): { events: unknown[] } => JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8'));
function setup(provider: Provider, window = 'window', owned = () => false) {
  const signals: Signal[] = []; const router = new AgentEventRouter(provider, window, 'runtime', signal => signals.push(signal), new Diagnostics(), owned);
  return { signals, router };
}
const result = (uuid: string, user = 'request') => ({ type: 'result', subtype: 'success', is_error: false, uuid, user_message_uuid: user, session_id: 'session', result: '한국어😀' });

test('Captured Codex and Claude events use the common notification model', () => {
  for (const provider of ['codex', 'claude'] as const) {
    const f = setup(provider); for (const event of fixture(`${provider}-success`).events) f.router.incoming(event);
    assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.status, 'completed');
    assert.equal(f.signals[0]!.source, 'verifiedIntegration'); assert.equal(f.signals[0]!.windowInstanceId, 'window');
    assert.equal(f.signals[0]!.connectionId, f.router.connectionId);
  }
});

test('Existing Codex turns notify without a start event; history responses and duplicates do not', () => {
  const f = setup('codex'); const events = fixture('codex-success').events;
  f.router.incoming({ id: 1, result: { thread: { id: 'captured-session', turns: events } } }); assert.equal(f.signals.length, 0);
  for (const event of events.slice(1)) f.router.incoming(event);
  assert.equal(f.signals.length, 1); assert.ok(f.signals[0]!.text.length);
  for (const event of events) f.router.incoming(event); assert.equal(f.signals.length, 1);
});

test('Ephemeral and subagent Codex threads are excluded; windows and owned sessions stay separate', () => {
  const a = setup('codex', 'A'), b = setup('codex', 'B'), own = setup('codex', 'own', () => true);
  a.router.outgoing({ id: 'start', method: 'thread/start', params: { ephemeral: true } });
  a.router.incoming({ id: 'start', result: { thread: { id: 'captured-session' } } });
  for (const event of fixture('codex-success').events) { a.router.incoming(event); b.router.incoming(event); own.router.incoming(event); }
  assert.equal(a.signals.length, 0); assert.equal(own.signals.length, 0); assert.equal(b.signals.length, 1); assert.equal(b.signals[0]!.windowInstanceId, 'B');
  const sub = setup('codex'); sub.router.incoming({ method: 'thread/started', params: { thread: { id: 'captured-session', parentThreadId: 'parent' } } });
  for (const event of fixture('codex-success').events) sub.router.incoming(event); assert.equal(sub.signals.length, 0);
});

test('Claude result replay cannot consume the next input; mismatched foreground results are ignored', () => {
  const f = setup('claude');
  f.router.outgoing({ type: 'user', uuid: 'first' }); f.router.incoming({ type: 'system', subtype: 'init', session_id: 'session' });
  f.router.incoming({ type: 'assistant', session_id: 'session', message: { content: 'not finished' } }); assert.equal(f.signals.length, 0);
  f.router.incoming(result('one', 'first')); f.router.outgoing({ type: 'user', uuid: 'second' });
  f.router.incoming(result('one', 'first')); f.router.incoming(result('other', 'unrelated'));
  assert.equal(f.signals.length, 1); f.router.incoming(result('two', 'second')); assert.equal(f.signals.length, 2);
  assert.deepEqual(f.signals.map(s => s.turnId), ['first', 'second']);
});

test('Claude questions and acknowledged interrupt use the existing control stream', () => {
  const f = setup('claude'); f.router.outgoing({ type: 'user', uuid: 'request', session_id: 'session' });
  f.router.incoming({ type: 'system', subtype: 'init', session_id: 'session' });
  f.router.incoming({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which color?' }] } } });
  f.router.incoming({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } });
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.status, 'waitingForInput');
  f.router.outgoing({ type: 'control_request', request_id: 'cancel', request: { subtype: 'interrupt' } }); assert.equal(f.signals.length, 1);
  f.router.incoming({ type: 'control_response', response: { subtype: 'success', request_id: 'cancel' } });
  assert.equal(f.signals[1]!.status, 'cancelled');
});

test('Observed errors stay errors, missing result text fails, and disposal stops all delivery', () => {
  for (const [provider, fixtureName] of [['codex', 'codex-api-error'], ['claude', 'claude-auth-error']] as const) {
    const f = setup(provider); for (const event of fixture(fixtureName).events) f.router.incoming(event);
    assert.equal(f.signals[0]!.status, 'error');
    f.router.dispose(); for (const event of fixture(`${provider}-success`).events) f.router.incoming(event); assert.equal(f.signals.length, 1);
  }
  const f = setup('claude'); assert.throws(() => f.router.incoming({ ...result('bad'), result: null }), /Malformed/); assert.equal(f.signals.length, 0);
});

test('A Claude input request already pending when observation starts is cleared by its real result', () => {
  const f = setup('claude'); f.router.incoming({ type: 'system', subtype: 'init', session_id: 'session' });
  f.router.incoming({ type: 'control_request', request_id: 'pending', request: { subtype: 'can_use_tool', tool_name: 'Write' } });
  assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.outgoing({ type: 'control_response', response: { subtype: 'success', request_id: 'pending' } });
  f.router.incoming(result('done')); assert.equal(f.signals.at(-1)!.status, 'completed'); assert.equal(f.router.snapshot().activeTurns, 0);
});

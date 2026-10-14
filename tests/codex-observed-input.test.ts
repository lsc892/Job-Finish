import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Diagnostics, Signal } from '../src/core/model';
import { Notifications } from '../src/core/notifications';
import { AgentEventRouter } from '../src/runtime/event-router';
import { AgentStreamObserver } from '../src/runtime/observe';
import { CodexAdapter } from '../src/runtime/codex';
import { fixture } from './helpers';

function router(owned = () => false) {
  const signals: Signal[] = [];
  const events = new AgentEventRouter('codex', 'window', 'runtime', signal => signals.push(signal), new Diagnostics(), owned);
  return { events, signals };
}
const start = (turnId = 'turn') => ({ method: 'turn/started', params: { threadId: 'thread', turn: { id: turnId, status: 'inProgress' } } });
const status = (flags: string[]) => ({ method: 'thread/status/changed', params: { threadId: 'thread', status: { type: 'active', activeFlags: flags } } });
const question = (requestId: number) => ({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn',
  itemId: 'question', isBlocking: true, questions: [{ id: 'color', header: 'Color', question: 'Which color?',
    options: [{ label: 'Blue', description: 'Pick blue.' }, { label: 'Green', description: 'Pick green.' }] }] } });
const dynamic = (requestId: number, tool: string, args: unknown, namespace: string | null = 'codex_app') => ({ id: requestId,
  method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: `call-${requestId}`, namespace, tool, arguments: args } });
const complete = () => ({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } } });

test('Observed structured questions preview choice labels and are deduplicated against status evidence', () => {
  const f = router();
  f.events.incoming({ method: 'thread/name/updated', params: { threadId: 'thread', threadName: 'Change notification color' } });
  f.events.incoming(start()); f.events.incoming(question(1)); f.events.incoming(question(1));
  f.events.incoming(status(['waitingOnUserInput']));
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.status, 'waitingForInput');
  assert.equal(f.signals[0]!.text, 'Which color?\n1. Blue\n2. Green'); assert.equal(f.signals[0]!.inputKind, 'question');
  assert.equal(f.signals[0]!.title, 'Change notification color');
  f.events.outgoing({ id: 1, result: { answers: { color: { answers: ['Blue'] } } } });
  f.events.incoming({ method: 'thread/name/updated', params: { threadId: 'thread', threadName: 'Apply selected color' } });
  f.events.incoming(status([])); f.events.incoming(question(2));
  assert.equal(f.signals.length, 2); assert.equal(f.signals[1]!.requestId, '2');
  assert.equal(f.signals[1]!.title, 'Apply selected color');
});

test('Status preceding a real question registers the request without sending a second toast', () => {
  const f = router(); f.events.incoming(start()); f.events.incoming(status(['waitingOnUserInput'])); f.events.incoming(question(1));
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.requestId, undefined);
  f.events.outgoing({ id: 1, error: { code: -1, message: 'Cancelled in the original UI' } });
  f.events.incoming(status([])); f.events.incoming(question(2)); assert.equal(f.signals.length, 2);
});

test('Codex option panels and onboarding questions notify through their real dynamic request IDs', () => {
  for (const request of [
    { id: 10, method: 'item/tool/requestOptionPicker', params: { threadId: 'thread', turnId: 'turn',
      question: 'Pick a task', options: [{ label: 'Fix' }, { label: 'Explain' }] } },
    dynamic(10, 'request_option_picker', { question: 'Pick a task', options: [{ label: 'Fix' }, { label: 'Explain' }] }),
    dynamic(10, 'request_onboarding_input', { questions: [{ id: 'task', question: 'Pick a task', options: [{ label: 'Fix' }, { label: 'Explain' }] }] }, null)
  ]) {
    const f = router(); f.events.incoming(request); f.events.incoming(request);
    assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.requestId, '10');
    assert.equal(f.signals[0]!.text, 'Pick a task\n1. Fix\n2. Explain');
    f.events.incoming({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 10 } });
    f.events.incoming(question(11)); assert.equal(f.signals.length, 2);
  }
});

test('Only verified blocking dynamic tool names and valid UI arguments notify', () => {
  const f = router(); f.events.incoming(start());
  for (const message of [
    dynamic(1, 'search', { question: 'A search query?', options: [] }),
    dynamic(2, 'request_option_picker', { question: 'Which?', options: [{ label: 'A' }] }, 'other_server'),
    dynamic(3, 'request_option_picker', { question: 'Which?', options: [null] }),
    dynamic(4, 'request_onboarding_input', { questions: [{ question: 'Which?', options: [] }] }),
    dynamic(5, 'request_environment_input', { mode: 'invalid' }),
    dynamic(6, 'setup_codex_step', { step: 'complete' }),
    dynamic(9, 'request_option_picker', { question: 'Which?', options: [{ label: 'A' }], allowMultiple: 'yes' }),
    dynamic(10, 'request_environment_input', { mode: 'network', domains: [42] })
  ]) f.events.incoming(message);
  assert.equal(f.signals.length, 0);
  f.events.incoming(dynamic(7, 'request_environment_input', { mode: 'network', reason: 'Allow access to this domain?' }));
  assert.equal(f.signals[0]!.text, 'Allow access to this domain?');
  f.events.outgoing({ id: 7, result: {} });
  f.events.incoming(dynamic(8, 'setup_codex_step', { step: 'task' })); assert.equal(f.signals.length, 2);
});

test('Dynamic panels stay in the original Codex UI and are excluded from directly owned execution', () => {
  const f = fixture({ sessionId: 'thread' }); const adapter = new CodexAdapter(f.session); f.session.start('turn', 'connection-1');
  adapter.handle(dynamic(1, 'request_option_picker', { question: 'Which?', options: [{ label: 'A' }] }), 'connection-1');
  assert.equal(f.session.requests.size, 0); assert.equal(f.signals.length, 0);
  const observed = router(() => true); observed.events.incoming(question(1));
  observed.events.incoming(dynamic(2, 'request_option_picker', { question: 'Which?', options: [{ label: 'A' }] }));
  assert.equal(observed.signals.length, 0);
});

test('Async agent questions notify without inventing requests; plain question text does not', () => {
  const f = fixture({ sessionId: 'thread' }); const adapter = new CodexAdapter(f.session); f.session.start('turn', 'connection-1', 'Repair notifications');
  const message = { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: {
    type: 'agentMessage', id: 'async-question', phase: 'commentary', text: 'What should I do next?',
    questions: [{ title: 'What should I do next?', options: ['Fix', 'Explain'] }] } } };
  adapter.handle(message, 'connection-1'); adapter.handle(message, 'connection-1');
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0]!.text, 'What should I do next?\n1. Fix\n2. Explain');
  assert.equal(f.signals[0]!.title, 'Repair notifications');
  assert.equal(f.session.requests.size, 0); assert.equal(f.signals[0]!.requestId, undefined);
  adapter.handle({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn',
    item: { type: 'userMessage', content: [{ type: 'text', text: 'Fix notification routing' }] } } }, 'connection-1');
  assert.equal(f.session.turns.get('turn')!.status, 'running');
  assert.equal(f.session.turns.get('turn')!.title, 'Fix notification routing');
  adapter.handle({ ...message, params: { ...message.params, item: { ...message.params.item, id: 'ordinary', questions: [] } } }, 'connection-1');
  assert.equal(f.signals.length, 1);
});

test('Thread waiting flags need an observed live turn and notify once per wait episode', () => {
  const f = router(); f.events.incoming(status(['waitingOnUserInput'])); assert.equal(f.signals.length, 0);
  f.events.incoming(start()); f.events.incoming(status(['waitingOnUserInput'])); f.events.incoming(status(['waitingOnUserInput']));
  assert.equal(f.signals.length, 1);
  f.events.incoming(status([])); f.events.incoming(status(['waitingOnUserInput'])); assert.equal(f.signals.length, 2);
  f.events.incoming(status([])); f.events.incoming(status(['waitingOnApproval']));
  assert.equal(f.signals.length, 3); assert.equal(f.signals[2]!.inputKind, 'approval');
  f.events.incoming(complete()); assert.equal(f.signals[3]!.status, 'completed');
  f.events.incoming(status(['waitingOnUserInput'])); assert.equal(f.signals.length, 4);
});

test('Thread status does not bind history, ambiguous turns, ephemeral threads, or stale connections', () => {
  const f = router(); f.events.incoming({ id: 5, result: { thread: { id: 'thread', status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, turns: [start()] } } });
  f.events.incoming(status(['waitingOnUserInput'])); assert.equal(f.signals.length, 0);
  f.events.incoming(start('one')); f.events.incoming(start('two')); f.events.incoming(status(['waitingOnUserInput'])); assert.equal(f.signals.length, 0);
  const hidden = router(); hidden.events.incoming({ method: 'thread/started', params: { thread: { id: 'thread', parentThreadId: 'parent' } } });
  hidden.events.incoming(question(1)); hidden.events.incoming(status(['waitingOnUserInput'])); assert.equal(hidden.signals.length, 0);
  const direct = fixture({ sessionId: 'thread' }); direct.session.start('turn', 'connection-1');
  new CodexAdapter(direct.session).handle(status(['waitingOnApproval']), 'stale'); assert.equal(direct.signals.length, 0);
});

test('Observed async question replies clear the notice without producing a fake completion', () => {
  const f = router(); f.events.incoming(start());
  const async = (id: string) => ({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
    item: { type: 'agentMessage', id, phase: 'commentary', text: '', questions: [{ title: 'Pick one', options: ['A', 'B'] }] } } });
  f.events.incoming(async('first')); f.events.outgoing({ method: 'turn/steer', id: 99, params: { threadId: 'thread', input: [{ type: 'text', text: 'A' }] } });
  f.events.incoming(async('first')); f.events.incoming(async('second'));
  assert.equal(f.signals.length, 2); assert.ok(f.signals.every(signal => signal.status === 'waitingForInput'));
});

test('A real observed stdio selection panel sends a toast before the turn finishes and preserves provider bytes', async t => {
  let child: ChildProcess | undefined; const toasts: Signal[] = []; const bytes: Buffer[] = [];
  const diagnostics = new Diagnostics();
  const notifications = new Notifications({ focused: () => false, owns: signal => observer.owns(signal),
    stopFlash: () => {}, flash: () => {}, activate: () => {}, toast: async (signal, message, _click, allowed) => {
      if (allowed()) { assert.match(message, /Which color\?/); toasts.push(signal); }
    } });
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }],
    signal => { void notifications.deliver(signal); }, diagnostics);
  t.after(async () => {
    observer.dispose(); if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(done => { child!.once('close', done); child!.kill(); });
    }
  });
  observer.start(); child = spawn(process.execPath, [resolve('tests/fixtures/observed-agent.cjs'), 'app-server'], { stdio: 'pipe', windowsHide: true });
  child.stdout!.on('data', chunk => bytes.push(chunk));
  const events = [start(), dynamic(42, 'request_option_picker', { question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Green' }] })];
  child.stdin!.write(JSON.stringify({ events }) + '\n');
  const deadline = Date.now() + 4000;
  while (!toasts.length) { if (Date.now() > deadline) throw new Error('Question toast timed out'); await new Promise(done => setTimeout(done, 10)); }
  assert.equal(toasts.length, 1); assert.equal(toasts[0]!.status, 'waitingForInput');
  assert.equal(observer.snapshot().connections[0]!.activeTurns, 1);
  assert.equal(Buffer.concat(bytes).toString('utf8'), events.map(event => JSON.stringify(event) + '\n').join(''));
  assert.equal(diagnostics.entries.length, 0);
});

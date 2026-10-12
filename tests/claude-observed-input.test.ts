import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentEventRouter } from '../src/runtime/event-router';
import { Diagnostics, Signal } from '../src/core/model';
import { Notifications } from '../src/core/notifications';

// Synthetic frames use the installed SDK's control envelope. Dialog payload fields
// follow the installed Claude extension's auto_mode_server_fallback renderer.
const dialog = (id = 'dialog') => ({ type: 'control_request', request_id: id, request: {
  subtype: 'request_user_dialog', dialog_kind: 'auto_mode_server_fallback', tool_use_id: 'tool-dialog',
  payload: { title: 'Continue in auto mode?', paragraphs: ['Choose Continue or Stop in the original chat.'] },
} });
const question = (id = 'question') => ({ type: 'control_request', request_id: id, request: {
  subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{
    question: 'Which color should be used?', options: [{ label: 'Blue' }, { label: 'Green' }], multiSelect: false,
  }] },
} });
const initialize = (id: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
const initializeReply = (id: string, pending: Record<string, unknown> = {}) => ({ type: 'control_response', response: {
  subtype: 'success', request_id: id, response: {}, ...pending,
} });

function setup(focused = false, initialized = true) {
  const signals: Signal[] = [];
  const toasts: { signal: Signal; text: string }[] = [];
  const deliveries: Promise<void>[] = [];
  const notifications = new Notifications({
    focused: () => focused, owns: signal => signal.connectionId === router.connectionId,
    flash: () => {}, stopFlash: () => {}, activate: () => {},
    toast: async (signal, text, _click, allowed) => { if (allowed()) toasts.push({ signal, text }); },
  });
  const router = new AgentEventRouter('claude', 'window', 'runtime', signal => {
    signals.push(signal); deliveries.push(notifications.deliver(signal));
  }, new Diagnostics());
  if (initialized) {
    router.outgoing({ type: 'user', uuid: 'request', session_id: 'session', message: { content: 'Change notification color' } });
    router.incoming({ type: 'system', subtype: 'init', session_id: 'session' });
  }
  return { router, signals, toasts, delivered: () => Promise.all(deliveries) };
}

test('Observed Claude blocking dialog shows one waiting toast while its original UI awaits a choice', async () => {
  const f = setup();
  f.router.incoming(dialog()); f.router.incoming(dialog());
  await f.delivered();
  assert.equal(f.signals.length, 1);
  assert.equal(f.signals[0]!.status, 'waitingForInput');
  assert.equal(f.signals[0]!.requestId, 'dialog');
  assert.equal(f.signals[0]!.title, 'Change notification color');
  assert.equal(f.signals[0]!.source, 'verifiedIntegration');
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0]!.text, /Continue in auto mode\?/);
});

test('Observed Claude question and approval remain waiting requests on the same notification path', async () => {
  const f = setup(); f.router.incoming(question());
  f.router.incoming({ type: 'control_request', request_id: 'approval', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', title: 'Run the requested command?', input: { command: 'echo fixture' },
  } });
  await f.delivered();
  assert.deepEqual(f.signals.map(signal => signal.status), ['waitingForInput', 'waitingForInput']);
  assert.equal(f.toasts.length, 2);
  assert.match(f.toasts[0]!.text, /Which color should be used\?/);
  assert.match(f.toasts[0]!.text, /Blue \/ Green/);
  assert.equal(f.toasts[1]!.text, 'Run the requested command?');
});

test('Focused Claude choice records waiting state without showing a toast', async () => {
  const f = setup(true); f.router.incoming(dialog()); await f.delivered();
  assert.equal(f.signals[0]!.status, 'waitingForInput');
  assert.equal(f.toasts.length, 0);
});

for (const cancelled of [false, true]) test(`Original Claude dialog ${cancelled ? 'withdrawal' : 'answer'} does not generate a second waiting notification`, async () => {
  const f = setup(); f.router.incoming(dialog());
  if (cancelled) f.router.incoming({ type: 'control_cancel_request', request_id: 'dialog' });
  else f.router.outgoing({ type: 'control_response', response: { subtype: 'success', request_id: 'dialog',
    response: { behavior: 'completed', result: { choice: 'continue' } },
  } });
  assert.equal(f.router.snapshot().pendingRequests, 0);
  f.router.incoming({ type: 'result', subtype: 'success', is_error: false, uuid: 'done',
    user_message_uuid: 'request', session_id: 'session', result: 'Finished after the original UI response.' });
  await f.delivered();
  assert.deepEqual(f.signals.map(signal => signal.status), ['waitingForInput', 'completed']);
  assert.deepEqual(f.signals.map(signal => signal.title), ['Change notification color', 'Change notification color']);
  assert.equal(f.router.snapshot().activeTurns, 0);
});

test('A Claude dialog error response keeps the actual request pending until the original UI answers', async () => {
  const f = setup(); f.router.incoming(dialog());
  assert.equal(f.router.snapshot().pendingRequests, 1);
  f.router.outgoing({ type: 'control_response', response: { subtype: 'error', request_id: 'dialog', error: 'Unsupported dialog kind' } });
  assert.equal(f.router.snapshot().pendingRequests, 1);
  f.router.incoming(dialog());
  await f.delivered(); assert.equal(f.signals.length, 1);
  f.router.outgoing({ type: 'control_response', response: { subtype: 'success', request_id: 'dialog',
    response: { behavior: 'completed', result: { choice: 'continue' } },
  } });
  assert.equal(f.router.snapshot().pendingRequests, 0);
});

test('Claude permission control errors keep their previous resolution behavior', () => {
  const f = setup(); f.router.incoming(question());
  assert.equal(f.router.snapshot().pendingRequests, 1);
  f.router.outgoing({ type: 'control_response', response: { subtype: 'error', request_id: 'question', error: 'Permission callback failed' } });
  assert.equal(f.router.snapshot().pendingRequests, 0);
});

test('Claude terminal results clear a dialog that remained pending after an error response', () => {
  const f = setup(); f.router.incoming(dialog());
  f.router.outgoing({ type: 'control_response', response: { subtype: 'error', request_id: 'dialog', error: 'Unsupported dialog kind' } });
  f.router.incoming({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'error-result',
    user_message_uuid: 'request', session_id: 'session', errors: ['Dialog deadline elapsed.'] });
  assert.equal(f.router.snapshot().pendingRequests, 0);
  assert.equal(f.router.snapshot().activeTurns, 0);
  assert.equal(f.signals.at(-1)!.status, 'error');
});

test('A matching observed initialize response recovers pending Claude questions and dialogs once', async () => {
  const f = setup(); f.router.outgoing(initialize('reinitialize'));
  f.router.incoming(initializeReply('reinitialize', {
    pending_permission_requests: [question()], pending_user_dialog_requests: [dialog()],
  }));
  assert.deepEqual(f.signals.map(signal => signal.requestId), ['question', 'dialog']);
  assert.deepEqual(f.signals.map(signal => signal.title), ['Change notification color', 'Change notification color']);
  f.router.incoming(question()); f.router.incoming(dialog());
  await f.delivered();
  assert.deepEqual(f.signals.map(signal => signal.requestId), ['question', 'dialog']);
  assert.equal(f.toasts.length, 2);
});

test('Unmatched, failed, and replayed initialize responses cannot invent pending Claude input', () => {
  const f = setup(); const pending = { pending_user_dialog_requests: [dialog()] };
  f.router.incoming(initializeReply('unobserved', pending));
  f.router.outgoing(initialize('failed'));
  f.router.incoming({ type: 'control_response', response: { subtype: 'error', request_id: 'failed', error: 'Fixture failure', ...pending } });
  f.router.incoming(initializeReply('failed', pending));
  f.router.outgoing(initialize('empty'));
  f.router.incoming(initializeReply('empty'));
  f.router.incoming(initializeReply('empty', pending));
  assert.equal(f.signals.length, 0);
});

test('An opaque Claude dialog advertises waiting without serializing its tool data', async () => {
  const f = setup(); f.router.incoming({ type: 'control_request', request_id: 'opaque', request: {
    subtype: 'request_user_dialog', dialog_kind: 'fable_overage_consent_prompt',
    payload: { overagesEnabled: false, modelName: 'Fable', opaqueToolArgument: 'not a preview' },
  } });
  await f.delivered();
  assert.equal(f.signals[0]!.status, 'waitingForInput');
  assert.equal(f.toasts[0]!.text, 'Claude needs an answer (fable_overage_consent_prompt)');
  assert.doesNotMatch(f.toasts[0]!.text, /not a preview|overagesEnabled/);
});

test('Claude dialog observation requires a known session and a well-formed control request', () => {
  const unbound = setup(false, false); unbound.router.incoming(dialog());
  assert.equal(unbound.signals.length, 0);
  const f = setup();
  f.router.incoming({ ...dialog(), request_id: '' });
  f.router.incoming({ ...dialog(), request: { subtype: 'request_user_dialog', dialog_kind: '', payload: {} } });
  f.router.incoming({ ...dialog(), request: { subtype: 'request_user_dialog', dialog_kind: 'auto_mode_server_fallback', payload: null } });
  f.router.incoming({ ...dialog(), request: { subtype: 'unrelated_control', payload: {} } });
  assert.equal(f.signals.length, 0);
});

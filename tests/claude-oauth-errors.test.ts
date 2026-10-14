// Synthetic replay of the OAuth refresh error envelope emitted by Claude Code 2.1.296.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics, Signal } from '../src/core/model';
import { Notifications } from '../src/core/notifications';
import { AgentEventRouter } from '../src/runtime/event-router';

const refreshError = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again';
const alternateRefreshError = 'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again in a minute; if it keeps happening, close other Claude Code windows or sign in again with /login';

// The SDK exposes error: server_error, but omits the CLI's internal isApiErrorMessage flag.
function assistant(uuid: string, text = refreshError, userId?: string) {
  return { type: 'assistant', uuid, session_id: 'session', parent_tool_use_id: null, error: 'server_error',
    ...(userId ? { user_message_uuid: userId } : {}),
    message: { id: `message-${uuid}`, role: 'assistant', type: 'message', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text }] } };
}
function result(uuid: string, userId: string, text = refreshError, failed = true) {
  return { type: 'result', uuid, user_message_uuid: userId, session_id: 'session', subtype: 'success',
    is_error: failed, result: text };
}
function setup(focused = false) {
  const signals: Signal[] = []; const flashes: Signal[] = [];
  const toasts: { signal: Signal; message: string }[] = []; const deliveries: Promise<void>[] = [];
  const diagnostics = new Diagnostics(); let stops = 0;
  const notifications = new Notifications({ focused: () => focused,
    owns: signal => signal.windowInstanceId === 'window' && signal.connectionId === router.connectionId,
    flash: signal => flashes.push(signal), stopFlash: () => { stops++; }, activate: () => {},
    toast: async (signal, message, _click, allowed) => { if (allowed()) toasts.push({ signal, message }); } });
  const router = new AgentEventRouter('claude', 'window', 'runtime', signal => {
    signals.push(signal); deliveries.push(notifications.deliver(signal));
  }, diagnostics);
  const start = (id?: string, title = 'Retry Claude task') => {
    router.outgoing({ type: 'user', ...(id ? { uuid: id } : {}), session_id: 'session', message: { content: title } });
    router.incoming({ type: 'system', subtype: 'init', session_id: 'session' });
  };
  return { router, signals, flashes, toasts, diagnostics, notifications, start, stops: () => stops,
    drain: () => Promise.all(deliveries) };
}

for (const [label, text] of [['stream-json text', refreshError], ['alternate text', alternateRefreshError]]) {
  test(`Claude OAuth refresh ${label} shows an error toast before the terminal result`, async () => {
    const f = setup(); f.start('request');
    f.router.incoming(assistant('fault', text, 'request')); await f.drain();
    assert.equal(f.signals.length, 1); assert.equal(f.toasts.length, 1); assert.equal(f.flashes.length, 1);
    assert.equal(f.signals[0]!.status, 'error'); assert.equal(f.signals[0]!.turnId, 'request');
    assert.equal(f.signals[0]!.title, 'Retry Claude task'); assert.equal(f.signals[0]!.text, text);
    assert.equal(f.signals[0]!.source, 'verifiedIntegration'); assert.equal(f.signals[0]!.connectionId, f.router.connectionId);
    assert.equal(f.toasts[0]!.message, text); assert.equal(f.router.snapshot().activeTurns, 1);
    f.router.incoming(result('terminal', 'request', text)); await f.drain();
    assert.equal(f.toasts.length, 1); assert.equal(f.router.snapshot().activeTurns, 0);
  });
}

test('Claude repeats and its matching failed result produce one OAuth refresh alert', async () => {
  const f = setup(); f.start('request');
  f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(assistant('same-fault-new-message', refreshError, 'request'));
  await f.drain(); assert.equal(f.toasts.length, 1); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(result('terminal', 'request')); f.router.incoming(result('terminal', 'request')); await f.drain();
  assert.equal(f.signals.length, 1); assert.equal(f.toasts.length, 1); assert.equal(f.router.snapshot().activeTurns, 0);
  assert.equal(f.diagnostics.entries.some(entry => entry.message.includes('Conflicting terminal state')), false);
});

test('Claude fault messages replayed after their result cannot start another foreground turn', async () => {
  const f = setup(); f.start('request');
  f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(assistant('repeated-fault', refreshError));
  f.router.incoming(result('terminal', 'request'));
  f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(assistant('repeated-fault', refreshError));
  f.router.incoming(assistant('new-late-fault', refreshError, 'request'));
  await f.drain();
  assert.equal(f.signals.length, 1); assert.equal(f.toasts.length, 1); assert.equal(f.router.snapshot().activeTurns, 0);
});

test('Replayed Claude fault UUIDs cannot attach to the next queued foreground input', async () => {
  const f = setup(); f.start('first');
  f.router.incoming(assistant('fault', refreshError, 'first'));
  f.router.incoming(assistant('repeated-fault', refreshError));
  f.router.incoming(result('first-result', 'first')); f.start('second', 'Second task');
  f.router.incoming(assistant('fault', refreshError, 'first'));
  f.router.incoming(assistant('repeated-fault', refreshError)); await f.drain();
  assert.equal(f.signals.length, 1); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(assistant('second-fault', refreshError, 'second'));
  f.router.incoming(result('second-result', 'second')); await f.drain();
  assert.deepEqual(f.signals.map(signal => signal.turnId), ['first', 'second']);
  assert.equal(f.toasts.length, 2); assert.equal(f.router.snapshot().activeTurns, 0);
});

test('Claude OAuth fault replay after an acknowledged interrupt cannot reopen the cancelled turn', async () => {
  const f = setup(); f.start('request');
  f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(assistant('repeated-fault', refreshError));
  f.router.outgoing({ type: 'control_request', request_id: 'interrupt', request: { subtype: 'interrupt' } });
  f.router.incoming({ type: 'control_response', response: { subtype: 'success', request_id: 'interrupt' } });
  f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(assistant('repeated-fault', refreshError));
  f.router.incoming(assistant('new-late-fault', refreshError, 'request')); await f.drain();
  assert.deepEqual(f.signals.map(signal => signal.status), ['error', 'cancelled']);
  assert.equal(f.toasts.length, 2); assert.equal(f.router.snapshot().activeTurns, 0);
});

test('A successful Claude result after an OAuth refresh alert still reports recovery', async () => {
  const f = setup(); f.start('request'); f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(result('recovered', 'request', 'Claude resumed and finished the task.', false)); await f.drain();
  assert.deepEqual(f.signals.map(signal => signal.status), ['error', 'completed']);
  assert.deepEqual(f.toasts.map(toast => toast.message), [refreshError, 'Claude resumed and finished the task.']);
  assert.equal(f.router.snapshot().activeTurns, 0);
  assert.equal(f.diagnostics.entries.some(entry => entry.message.includes('Conflicting terminal state')), false);
});

test('An unrelated failed result after the OAuth alert remains a separate error notification', async () => {
  const f = setup(); f.start('request'); f.router.incoming(assistant('fault', refreshError, 'request'));
  f.router.incoming(result('other-error', 'request', 'API Error: unavailable model')); await f.drain();
  assert.deepEqual(f.signals.map(signal => signal.status), ['error', 'error']);
  assert.deepEqual(f.toasts.map(toast => toast.message), [refreshError, 'API Error: unavailable model']);
  assert.equal(f.router.snapshot().activeTurns, 0);
});

test('Quoted OAuth text, unrelated errors, tool output and subagents do not create foreground OAuth alerts', async () => {
  const unmarked = assistant('quote'); const { error: _error, ...quote } = unmarked;
  const excluded = [quote,
    assistant('other-error', 'The server is temporarily unavailable.'),
    { ...assistant('subagent'), parent_tool_use_id: 'subagent-tool' },
    { type: 'user', uuid: 'tool-output', session_id: 'session', message: { content: [{ type: 'tool_result', content: refreshError }] } },
    { type: 'system', subtype: 'informational', session_id: 'session', content: refreshError },
  ];
  for (const message of excluded) {
    const f = setup(); f.start('request'); f.router.incoming(message); await f.drain();
    assert.equal(f.signals.length, 0); assert.equal(f.toasts.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  }
});

test('A Claude OAuth fault for another queued user UUID cannot notify or consume the foreground input', async () => {
  const f = setup(); f.start('first');
  f.router.outgoing({ type: 'user', uuid: 'second', session_id: 'session', message: { content: 'Second task' } });
  f.router.incoming(assistant('wrong-request', refreshError, 'second')); await f.drain();
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(assistant('first-fault', refreshError, 'first'));
  f.router.incoming(result('first-result', 'first'));
  f.router.incoming(assistant('second-fault', refreshError, 'second'));
  f.router.incoming(result('second-result', 'second')); await f.drain();
  assert.deepEqual(f.signals.map(signal => [signal.turnId, signal.title]), [['first', 'Retry Claude task'], ['second', 'Second task']]);
  assert.equal(f.toasts.length, 2); assert.equal(f.router.snapshot().activeTurns, 0);
});

test('The next Claude turn can report the same OAuth failure independently', async () => {
  const f = setup(); f.start('first');
  f.router.incoming(assistant('first-fault', refreshError, 'first')); f.router.incoming(result('first-result', 'first'));
  f.start('second', 'Second task');
  f.router.incoming(assistant('second-fault', refreshError, 'second')); f.router.incoming(result('second-result', 'second'));
  await f.drain();
  assert.deepEqual(f.signals.map(signal => signal.turnId), ['first', 'second']); assert.equal(f.toasts.length, 2);
  assert.equal(f.router.snapshot().activeTurns, 0);
});

test('A runtime-added Claude user UUID preserves OAuth deduplication and advances the input once', async () => {
  const f = setup(); f.start();
  f.router.incoming(assistant('fault', refreshError, 'runtime-user-id')); await f.drain();
  assert.equal(f.signals.length, 1); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(result('terminal', 'runtime-user-id')); await f.drain();
  assert.equal(f.signals.length, 1); assert.equal(f.router.snapshot().activeTurns, 0);
  f.start('next'); f.router.incoming(result('next-terminal', 'next', 'Next request finished.', false)); await f.drain();
  assert.deepEqual(f.signals.map(signal => signal.status), ['error', 'completed']);
  assert.equal(f.signals[1]!.turnId, 'next'); assert.equal(f.router.snapshot().activeTurns, 0);
});

for (const userId of ['existing-user-id', undefined]) {
  test(`An existing Claude stream reports OAuth failure without observing its outgoing prompt (${userId ?? 'no UUID'})`, async () => {
    const f = setup(); f.router.incoming({ type: 'system', subtype: 'init', session_id: 'session' });
    f.router.incoming(assistant('existing-fault', refreshError, userId)); await f.drain();
    assert.equal(f.signals.length, 1); assert.equal(f.toasts.length, 1); assert.equal(f.router.snapshot().activeTurns, 1);
    f.router.incoming(result('existing-terminal', userId ?? 'runtime-added-user-id')); await f.drain();
    assert.equal(f.signals.length, 1); assert.equal(f.toasts.length, 1); assert.equal(f.router.snapshot().activeTurns, 0);
  });
}

test('A focused window records a Claude OAuth failure without a Windows toast or flash', async () => {
  const f = setup(true); f.start('request'); f.router.incoming(assistant('fault', refreshError, 'request')); await f.drain();
  assert.equal(f.signals.length, 1); assert.equal(f.notifications.results.length, 1);
  assert.equal(f.notifications.results[0]!.status, 'error'); assert.equal(f.toasts.length, 0); assert.equal(f.flashes.length, 0);
  assert.equal(f.stops(), 1); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(result('terminal', 'request')); await f.drain();
  assert.equal(f.notifications.results.length, 1); assert.equal(f.router.snapshot().activeTurns, 0);
});

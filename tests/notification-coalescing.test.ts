// 비동기 질문 직후 완료의 알림 병합·시간 경계·실패 대체·격리를 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifications, NotificationPorts } from '../src/core/notifications';
import { Diagnostics, LIMITS, Signal } from '../src/core/model';
import { binding } from './helpers';

function setup(ports: Partial<NotificationPorts> = {}) {
  const state = { now: 0, focused: false, enabled: true, owns: true, stops: 0 };
  const toasts: Signal[] = []; const flashes: Signal[] = [];
  const notifications = new Notifications({
    enabled: () => state.enabled, focused: () => state.focused, owns: () => state.owns,
    stopFlash: () => { state.stops++; }, flash: signal => { flashes.push(signal); }, activate: () => {},
    toast: async (signal, _text, _click, allowed) => { if (allowed()) toasts.push(signal); }, ...ports,
  }, () => state.now);
  return { state, toasts, flashes, notifications };
}
const question = (overrides: Partial<Signal> = {}): Signal => ({ ...binding(), notificationId: 'question',
  turnId: 'turn', status: 'waitingForInput', text: '어떤 환경인가요?', truncated: false, at: '', kind: 'asyncQuestion', ...overrides });
const completion = (overrides: Partial<Signal> = {}): Signal => ({ ...question(), notificationId: 'completion',
  status: 'completed', text: '답변을 기다리겠습니다.', kind: undefined, ...overrides });

test('Questions alert immediately and only completions within five seconds merge, while both results remain stored', async () => {
  for (const elapsed of [0, 3000, 5000, 5001]) {
    const f = setup();
    await f.notifications.deliver(question());
    assert.equal(f.toasts.length, 1);
    f.state.now = elapsed;
    await f.notifications.deliver(completion());
    assert.equal(f.toasts.length, elapsed <= 5000 ? 1 : 2, `${elapsed} ms`);
    assert.equal(f.flashes.length, f.toasts.length);
    assert.equal(f.state.stops, 0, 'merging keeps the question flash and click route alive');
    assert.deepEqual(f.notifications.results.map(signal => signal.status), ['waitingForInput', 'completed']);
  }
});

test('Question merging cannot cross a window, provider, runtime, connection, session or turn', async () => {
  for (const field of ['windowInstanceId', 'provider', 'runtimeId', 'connectionId', 'sessionId', 'turnId'] as const) {
    const f = setup(); await f.notifications.deliver(question());
    await f.notifications.deliver(completion({ [field]: 'other' }));
    assert.equal(f.toasts.length, 2, field);
  }
});

test('Errors, cancellation and blocking input requests always keep their own terminal alerts', async () => {
  for (const status of ['error', 'cancelled'] as const) {
    const f = setup(); await f.notifications.deliver(question());
    await f.notifications.deliver(completion({ status }));
    assert.deepEqual(f.toasts.map(signal => signal.status), ['waitingForInput', status]);
  }
  const f = setup();
  await f.notifications.deliver(question({ kind: undefined, requestId: 'blocking-input' }));
  await f.notifications.deliver(completion());
  assert.equal(f.toasts.length, 2);
});

test('A question received while focused or disabled cannot swallow a later background completion', async () => {
  for (const field of ['focused', 'enabled'] as const) {
    const f = setup(); f.state[field] = field === 'focused';
    await f.notifications.deliver(question());
    f.state[field] = field !== 'focused';
    await f.notifications.deliver(completion());
    assert.deepEqual(f.toasts.map(signal => signal.status), ['completed']);
  }
});

test('A completion waits for an in-flight question delivery and falls back when that delivery fails', async () => {
  for (const fails of [false, true]) {
    let settle!: () => void; const calls: string[] = [];
    const pending = new Promise<void>((resolve, reject) => { settle = () => fails ? reject(new Error('toast failed')) : resolve(); });
    const f = setup({ toast: (signal) => { calls.push(signal.status); return signal.kind === 'asyncQuestion' ? pending : Promise.resolve(); } });
    const first = f.notifications.deliver(question());
    const outcome = first.then(() => undefined, error => error as Error);
    const last = f.notifications.deliver(completion());
    assert.deepEqual(calls, ['waitingForInput'], 'completion must not replace a question still being registered');
    settle(); await last;
    assert.equal((await outcome)?.message, fails ? 'toast failed' : undefined);
    assert.deepEqual(calls, fails ? ['waitingForInput', 'completed'] : ['waitingForInput']);
  }
});

test('A completion rechecks focus, enabled state and ownership after waiting for failed question delivery', async () => {
  for (const field of ['focused', 'enabled', 'owns'] as const) {
    let fail!: () => void; const calls: string[] = [];
    const pending = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error('toast failed')); });
    const f = setup({ toast: signal => { calls.push(signal.status); return pending; } });
    const first = f.notifications.deliver(question()).catch(() => {});
    const last = f.notifications.deliver(completion());
    f.state[field] = field === 'focused'; fail();
    await Promise.all([first, last]);
    assert.deepEqual(calls, ['waitingForInput'], field);
  }
});

test('A question skipped after registration by a focus change cannot swallow a later completion', async () => {
  let allowed!: () => boolean; let finish!: () => void; const toasts: string[] = [];
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = setup({ toast: (signal, _text, _click, canShow) => {
    if (signal.kind === 'asyncQuestion') { allowed = canShow; return pending; }
    if (canShow()) toasts.push(signal.status);
    return Promise.resolve();
  } });
  const first = f.notifications.deliver(question());
  f.state.focused = true; assert.equal(allowed(), false); finish(); await first;
  f.state.focused = false;
  await f.notifications.deliver(completion());
  assert.deepEqual(toasts, ['completed']);
});

test('The latest question starts a fresh merge window and old entries remain bounded', async () => {
  const f = setup(); await f.notifications.deliver(question());
  f.state.now = 4000; await f.notifications.deliver(question({ notificationId: 'next-question' }));
  f.state.now = 8000; await f.notifications.deliver(completion());
  assert.equal(f.toasts.length, 2);
  for (let i = 0; i <= LIMITS.dedup; i++) await f.notifications.deliver(question({ turnId: `turn-${i}` }));
  await f.notifications.deliver(completion({ turnId: 'turn-0' }));
  assert.equal(f.toasts.at(-1)!.status, 'completed', 'the oldest question is evicted');
  const count = f.toasts.length;
  await f.notifications.deliver(completion({ turnId: `turn-${LIMITS.dedup}` }));
  assert.equal(f.toasts.length, count, 'a retained recent question still merges');
});

test('Notification traces explain suppression and correlate delivery without recording response text', async () => {
  const diagnostics = new Diagnostics();
  const f = setup({ trace: (event, fields) => diagnostics.trace(event, fields) });
  f.state.owns = false; await f.notifications.deliver(completion()); f.state.owns = true;
  f.state.enabled = false; await f.notifications.deliver(completion()); f.state.enabled = true;
  f.state.focused = true; await f.notifications.deliver(completion()); f.state.focused = false;
  await f.notifications.deliver(question()); await f.notifications.deliver(completion());
  assert.deepEqual(diagnostics.events.filter(entry => entry.event === 'notification.skipped').map(entry => entry.reason),
    ['not-owner', 'disabled', 'focused', 'recent-question']);
  assert.equal(f.toasts.length, 1);
  const dispatched = diagnostics.events.find(entry => entry.event === 'notification.dispatching')!;
  assert.equal(dispatched.notificationId, 'question'); assert.equal(dispatched.turnId, 'turn');
  assert.equal(dispatched.connectionId, binding().connectionId);
  assert.equal(JSON.stringify(diagnostics.events).includes(question().text), false);
  assert.equal(JSON.stringify(diagnostics.events).includes(completion().text), false);
});

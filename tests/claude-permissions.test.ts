import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Diagnostics, LIMITS } from '../src/core/model';
import { Session } from '../src/core/session';
import { ClaudePermissions, ClaudeTurnContext } from '../src/runtime/claude/permissions';
import { binding } from './helpers';

function setup() {
  let failSave = false;
  const session = new Session(binding({ provider: 'claude' }), () => true,
    () => { if (failSave) throw new Error('Checkpoint unavailable'); }, () => {}, new Diagnostics());
  session.start('turn', 'connection-1');
  const context: ClaudeTurnContext = { requestId: 'turn', connectionId: 'connection-1', acceptingInput: true };
  const permissions = new ClaudePermissions(session, turn => turn === context && turn.acceptingInput && session.valid(turn.connectionId));
  const callback = permissions.forTurn(context);
  const ask = (id: string, signal = new AbortController().signal, input = {}) =>
    callback('Bash', input, { signal, requestId: id, toolUseID: id });
  return { session, context, permissions, ask, failSave: () => { failSave = true; } };
}

test('Permission responses and bulk cleanup remove abort listeners and settle each pending callback', async () => {
  const f = setup();
  const controllers = [new AbortController(), new AbortController()];
  const first = f.ask('first', controllers[0]!.signal);
  const second = f.ask('second', controllers[1]!.signal);
  assert.deepEqual(controllers.map(controller => getEventListeners(controller.signal, 'abort').length), [1, 1]);
  f.permissions.respond('first', { behavior: 'allow', updatedInput: {} });
  assert.equal((await first)?.behavior, 'allow');
  f.permissions.clear();
  assert.equal((await second)?.behavior, 'deny');
  assert.equal(f.session.requests.size, 0);
  assert.deepEqual(controllers.map(controller => getEventListeners(controller.signal, 'abort').length), [0, 0]);
  for (const controller of controllers) controller.abort();
  f.permissions.clear();
  assert.throws(() => f.permissions.respond('first', { behavior: 'allow', updatedInput: {} }), /no longer/);
});

test('Duplicate, oversized and excess permissions preserve pending requests and enforce their bounds', async () => {
  const f = setup();
  await assert.rejects(f.ask('oversized', undefined, { text: 'x'.repeat(LIMITS.textBytes) }), /bounded capacity/);
  const pending = Array.from({ length: LIMITS.requests }, (_, index) => f.ask(String(index)));
  await assert.rejects(f.ask('0'), /bounded capacity/);
  await assert.rejects(f.ask('extra'), /bounded capacity/);
  assert.equal(f.session.requests.size, LIMITS.requests);
  f.permissions.respond('0', { behavior: 'deny', message: 'answered' });
  await assert.rejects(f.ask('1'), /Duplicate concurrent/);
  assert.equal(f.session.requests.size, LIMITS.requests - 1);
  f.permissions.clear();
  assert.ok((await Promise.all(pending)).every(answer => answer?.behavior === 'deny'));
});

test('An already withdrawn permission is denied without recording a request or keeping an abort listener', async () => {
  const f = setup();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await f.ask('withdrawn', controller.signal))?.behavior, 'deny');
  assert.equal(f.session.requests.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('A response checkpoint failure denies the SDK permission and still removes its listener', async () => {
  const f = setup();
  const controller = new AbortController();
  const answer = f.ask('saving', controller.signal);
  f.failSave();
  f.permissions.respond('saving', { behavior: 'allow', updatedInput: {} });
  assert.deepEqual(await answer, { behavior: 'deny', message: 'Cannot record input response' });
  assert.equal(f.session.requests.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Diagnostics, LIMITS } from '../src/core/model';
import { CodexConnection } from '../src/runtime/codex/connection';
import type { RpcMessage } from '../src/runtime/transport';

function connection(recover = async () => {}) {
  const messages: RpcMessage[] = [];
  const disconnects: unknown[] = [];
  const runtime = new CodexConnection({ cwd: process.cwd(), executable: resolve('tests/fixtures/app-server.cjs'), diagnostic: new Diagnostics() }, {
    message: message => messages.push(message),
    disconnected: reason => disconnects.push(reason),
    recover,
    canRecover: () => true,
  });
  return { runtime, messages, disconnects };
}

async function disconnect(runtime: CodexConnection): Promise<void> {
  await runtime.open();
  const { thread } = await runtime.rpc!.request<{ thread: { id: string } }>('thread/start', {});
  await runtime.rpc!.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'disconnect' }] });
  const deadline = Date.now() + 5000;
  while (runtime.rpc!.connected) {
    if (Date.now() > deadline) throw new Error('Fixture did not disconnect');
    await nextTick();
  }
}

test('Connection buffers early events in order until the session is ready', async t => {
  const f = connection();
  t.after(() => f.runtime.dispose());
  await f.runtime.open();
  const { thread } = await f.runtime.rpc!.request<{ thread: { id: string } }>('thread/start', {});
  await f.runtime.rpc!.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'wait' }] });
  await f.runtime.rpc!.request('turn/interrupt', { threadId: thread.id });
  // A following response ensures the preceding terminal events have reached the queue.
  await f.runtime.rpc!.request('thread/read', { threadId: thread.id });
  assert.equal(f.runtime.ready, false);
  assert.equal(f.messages.length, 0);
  f.runtime.activate();
  assert.equal(f.runtime.ready, true);
  assert.deepEqual(f.messages.map(message => message.method), ['turn/started', 'item/completed', 'turn/completed', 'turn/completed']);
});

test('Answer replay is bounded by count and bytes and never crosses a connection generation', async t => {
  const f = connection();
  t.after(() => f.runtime.dispose());
  await f.runtime.open();
  const sent: unknown[] = [];
  t.mock.method(f.runtime.rpc!, 'respond', (_id: unknown, result: unknown) => { sent.push(result); });
  const message = (id: number): RpcMessage => ({ id, method: 'item/commandExecution/requestApproval' });
  for (let i = 0; i <= LIMITS.dedup; i++) f.runtime.rememberAnswer(JSON.stringify(i), { decision: 'decline' });
  assert.equal(f.runtime.replayAnswer(message(0)), false);
  assert.equal(f.runtime.replayAnswer(message(1)), true);
  assert.deepEqual(sent, [{ decision: 'decline' }]);
  assert.equal(f.runtime.replayAnswer({ id: 1 }), false);
  f.runtime.rememberAnswer('"oversized"', 'x'.repeat(LIMITS.queueBytes));
  assert.equal(f.runtime.replayAnswer(message(1)), false);
  assert.equal(f.runtime.replayAnswer({ id: 'oversized', method: 'approval' }), false);
  f.runtime.rememberAnswer('42', { decision: 'accept' });
  const previous = f.runtime.rpc!;
  f.runtime.close();
  await f.runtime.open();
  assert.equal(f.runtime.isCurrent(previous), false);
  assert.equal(f.runtime.replayAnswer(message(42)), false);
});

test('Concurrent reconnects share one recovery and a failed recovery permits a later retry', async t => {
  let calls = 0;
  let rejectRecovery!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectRecovery = reject; });
  const f = connection(async () => { if (++calls === 1) await pending; });
  t.after(() => f.runtime.dispose());
  const first = assert.rejects(f.runtime.reconnect(), /recovery failed/);
  const second = assert.rejects(f.runtime.reconnect(), /recovery failed/);
  assert.equal(calls, 1);
  rejectRecovery(new Error('recovery failed'));
  await Promise.all([first, second]);
  await f.runtime.reconnect();
  assert.equal(calls, 2);
});

test('Automatic recovery backs off at one, two and four seconds and stops after three attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const f = connection(async () => { calls++; throw new Error('offline'); });
  t.after(() => f.runtime.dispose());
  await disconnect(f.runtime);
  for (const delay of [1000, 2000, 4000]) {
    const previous = calls;
    t.mock.timers.tick(delay - 1);
    assert.equal(calls, previous);
    t.mock.timers.tick(1);
    await nextTick();
    assert.equal(calls, previous + 1);
  }
  t.mock.timers.tick(60_000);
  await nextTick();
  assert.equal(calls, 3);
});

test('Disposal cancels an already scheduled recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const f = connection(async () => { calls++; });
  t.after(() => f.runtime.dispose());
  await disconnect(f.runtime);
  f.runtime.dispose();
  t.mock.timers.tick(10_000);
  await nextTick();
  assert.equal(f.runtime.disposed, true);
  assert.equal(calls, 0);
  assert.ok(f.disconnects.includes('Session released'));
});

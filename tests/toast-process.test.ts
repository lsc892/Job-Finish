import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Diagnostics } from '../src/core/model';
import { ToastProcessRunner } from '../src/windows/toast-process';

function setup(closeOnKill = true) {
  const children: { child: EventEmitter; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kills: number }[] = [];
  const diagnostics = new Diagnostics();
  const runner = new ToastProcessRunner('controlled-helper', diagnostics, { launch: () => {
    const child = new EventEmitter();
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    const item = { child, stdin, stdout, stderr, kills: 0 };
    children.push(item);
    Object.assign(child, { pid: children.length, stdin, stdout, stderr, kill: () => {
      item.kills++;
      if (closeOnKill) setImmediate(() => child.emit('close', null, 'SIGTERM'));
    } });
    return child as ChildProcess;
  } });
  return { runner, children, diagnostics };
}

test('Helper completion waits for stream close and receives split diagnostics after exit', async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const events: Record<string, unknown>[] = [];
  const run = f.runner.run(['--show'], { notificationId: 'drained' }, event => events.push(event));
  const child = f.children[0]!;
  let completed = false;
  void run.completion.then(() => { completed = true; });
  child.stdout.write('{"event":"toast.sub');
  child.child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(completed, false);
  child.stdout.write('mitted"}\n');
  assert.equal(events[0]?.event, 'toast.submitted');
  child.child.emit('close', 0, null);
  await run.completion;
  assert.equal(completed, true);
  assert.equal(f.diagnostics.events[0]?.notificationId, 'drained');
  f.runner.dispose();
  assert.equal(child.kills, 0, 'a closed helper is no longer owned by the runner');
});

test('A helper ending with partial JSON fails even after an otherwise valid frame', async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  const events: Record<string, unknown>[] = [];
  const run = f.runner.run(['--register'], undefined, event => events.push(event));
  const failure = assert.rejects(run.completion, /incomplete diagnostics: true/);
  f.children[0]!.stdout.write('{"event":"ready"}\n{"event":');
  f.children[0]!.child.emit('close', 0, null);
  await failure;
  assert.equal(events.length, 1);
});

test('Malformed or oversized diagnostics cancel their helper and preserve the cause', async t => {
  const f = setup(); t.after(() => f.runner.dispose());
  for (const [output, expected] of [['[]\n', /Invalid native toast diagnostics/], ['x'.repeat(32769), /exceed 32 KiB/]] as const) {
    const run = f.runner.run(['--register'], undefined, () => assert.fail('invalid data must not be delivered'));
    const child = f.children.at(-1)!;
    const failure = assert.rejects(run.completion, expected);
    child.stdout.write(output);
    await failure;
    assert.equal(child.kills, 1);
  }
});

test('A helper timeout rejects at 15 seconds even when cancellation never closes its streams', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(false); t.after(() => f.runner.dispose());
  const run = f.runner.run(['--register'], undefined, () => {});
  const failure = assert.rejects(run.completion, /helper timed out/);
  t.mock.timers.tick(14_999);
  assert.equal(f.children[0]!.kills, 0);
  t.mock.timers.tick(1);
  await failure;
  assert.equal(f.children[0]!.kills, 1);
  f.children[0]!.child.emit('close', null, 'SIGTERM');
});

test('Individual cancellation leaves other helpers running, while disposal also cancels registration', async () => {
  const f = setup();
  const first = f.runner.run(['--show'], { notificationId: 'first' }, () => {});
  const second = f.runner.run(['--show'], { notificationId: 'second' }, () => {});
  const registration = f.runner.run(['--register'], undefined, () => {});
  const failures = [first, second, registration].map(run => assert.rejects(run.completion, /Native toast helper exited/));
  first.cancel();
  await failures[0];
  assert.deepEqual(f.children.map(child => child.kills), [1, 0, 0]);
  f.runner.dispose();
  await Promise.all(failures);
  assert.deepEqual(f.children.map(child => child.kills), [1, 1, 1]);
});

test('Synchronous launch errors reject completion without escaping the runner call', async () => {
  const cause = new Error('launch failed');
  const runner = new ToastProcessRunner('missing-helper', new Diagnostics(), { launch: () => { throw cause; } });
  const run = runner.run(['--register'], undefined, () => {});
  await assert.rejects(run.completion, error => error === cause);
});

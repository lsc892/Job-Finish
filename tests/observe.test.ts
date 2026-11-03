// 기존·신규 에이전트 스트림의 비파괴 관찰과 프레임 경계·종료·설정 전환을 검증한다.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { AgentStreamObserver } from '../src/runtime/observe';
import { Diagnostics, Signal } from '../src/core/model';
import { Notifications } from '../src/core/notifications';

const agent = resolve('tests/fixtures/observed-agent.cjs');
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
function cleanup(t: TestContext, child: ChildProcess): void {
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); });
  });
}
async function until(fn: () => boolean) { const deadline = Date.now() + 4000; while (!fn()) { if (Date.now() > deadline) throw new Error('Observed stream timeout'); await pause(); } }
const events = (id: string, text = '한국어😀') => [
  { method: 'turn/started', params: { threadId: 'thread', turn: { id, status: 'inProgress' } } },
  { method: 'item/completed', params: { threadId: 'thread', turnId: id, item: { type: 'agentMessage', phase: 'final_answer', text } } },
  { method: 'turn/completed', params: { threadId: 'thread', turn: { id, status: 'completed', items: [] } } },
];
const packet = (id: string) => JSON.stringify({ events: events(id) }) + '\n';

test('Observed async questions reach toast delivery once, obey focus, and preserve the original stream', async t => {
  const diagnostics = new Diagnostics();
  let focused = false; let flashes = 0;
  const toasts: string[] = []; const deliveries: Promise<void>[] = [];
  const notifications = new Notifications({ focused: () => focused, owns: signal => observer.owns(signal),
    stopFlash: () => {}, flash: () => { flashes++; }, activate: () => {},
    toast: async (_signal, message, _click, allowed) => { if (allowed()) toasts.push(message); } });
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }],
    signal => deliveries.push(notifications.deliver(signal)), diagnostics);
  t.after(() => observer.dispose()); observer.start();
  const child = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, child);
  const output: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk));
  const question = { method: 'item/started', params: { threadId: 'thread', turnId: 'turn',
    item: { type: 'agentMessage', id: 'question-1', phase: 'final_answer', delivery: 'async', text: 'question widget payload', questions: [{ title: '답변이 필요합니다😀', options: null }] } } };
  child.stdin.write(JSON.stringify({ events: [question, question] }) + '\n');
  await until(() => notifications.results.length === 1); await Promise.all(deliveries);
  assert.deepEqual(toasts, ['답변이 필요합니다😀']); assert.equal(flashes, 1);
  const questionCompleted = { ...question, method: 'item/completed' };
  child.stdin.write(JSON.stringify({ events: [questionCompleted] }) + '\n');
  focused = true;
  const next = { ...question, params: { ...question.params, item: { ...question.params.item, id: 'question-2' } } };
  child.stdin.write(JSON.stringify({ events: [next] }) + '\n');
  await until(() => notifications.results.length === 2); await Promise.all(deliveries);
  assert.equal(toasts.length, 1, 'focused windows retain the question without displaying a toast');
  assert.equal(flashes, 1);
  const completed = { method: 'turn/completed', params: { threadId: 'thread',
    turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Done' }] } } };
  child.stdin.write(JSON.stringify({ events: [completed] }) + '\n');
  await until(() => notifications.results.length === 3); await Promise.all(deliveries);
  assert.deepEqual(notifications.results.map(signal => [signal.status, signal.text]),
    [['waitingForInput', '답변이 필요합니다😀'], ['waitingForInput', '답변이 필요합니다😀'], ['completed', 'Done']]);
  assert.equal(observer.snapshot().connections[0]!.activeTurns, 0);
  assert.equal(Buffer.concat(output).toString('utf8'), [question, question, questionCompleted, next, completed].map(event => JSON.stringify(event) + '\n').join(''));
  assert.deepEqual(diagnostics.entries, []);
});

test('An observed question followed immediately by completion produces one toast and retains both results', async t => {
  const diagnostics = new Diagnostics(); const toasts: string[] = []; const deliveries: Promise<void>[] = [];
  let flashes = 0;
  const notifications = new Notifications({ focused: () => false, owns: signal => observer.owns(signal),
    stopFlash: () => {}, flash: () => { flashes++; }, activate: () => {},
    toast: async (_signal, message, _click, allowed) => { if (allowed()) toasts.push(message); } });
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }],
    signal => deliveries.push(notifications.deliver(signal)), diagnostics);
  t.after(() => observer.dispose()); observer.start();
  const child = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, child);
  const output: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk));
  const params = { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'question',
    phase: 'commentary', delivery: 'async', text: '', questions: [{ title: '어느 환경인가요?' }] } };
  const stream = [{ method: 'item/started', params }, { method: 'item/completed', params },
    ...events('turn', '답변을 기다리겠습니다.').slice(1)];
  child.stdin.write(JSON.stringify({ events: stream }) + '\n');
  await until(() => notifications.results.length === 2); await Promise.all(deliveries);
  assert.deepEqual(toasts, ['어느 환경인가요?']); assert.equal(flashes, 1);
  assert.equal(notifications.results[0]!.kind, 'asyncQuestion');
  assert.deepEqual(notifications.results.map(signal => [signal.status, signal.text]),
    [['waitingForInput', '어느 환경인가요?'], ['completed', '답변을 기다리겠습니다.']]);
  assert.equal(observer.snapshot().connections[0]!.activeTurns, 0);
  assert.equal(Buffer.concat(output).toString('utf8'), stream.map(event => JSON.stringify(event) + '\n').join(''));
  assert.deepEqual(diagnostics.entries, []);
});

test('Automatic observation attaches existing and future processes, leaves bytes unchanged, and toggles cleanly', async t => {
  const signals: Signal[] = []; const diagnostics = new Diagnostics();
  const roots = () => [{ provider: 'codex' as const, path: resolve('tests/fixtures') }];
  const existing = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, existing);
  const originalWrite = existing.stdin.write; const originalSpawn = (ChildProcess.prototype as unknown as { spawn: unknown }).spawn;
  const observed: Buffer[] = []; existing.stdout.on('data', chunk => observed.push(chunk));
  const observer = new AgentStreamObserver('window', roots, signal => signals.push(signal), diagnostics); t.after(() => observer.dispose());
  observer.start(); assert.equal(observer.snapshot().connections.length, 1);
  existing.stdin.write(packet('existing')); await until(() => signals.length === 1);
  assert.equal(Buffer.concat(observed).toString('utf8'), events('existing').map(e => JSON.stringify(e) + '\n').join(''));
  const future = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, future);
  future.stdout.resume(); future.stdin.write(packet('future')); await until(() => signals.length === 2);
  assert.equal(observer.snapshot().connections.length, 2); assert.equal(observer.snapshot().pollingTimers, 0);
  observer.stop(); assert.equal(existing.stdin.write, originalWrite); assert.equal((ChildProcess.prototype as unknown as { spawn: unknown }).spawn, originalSpawn);
  existing.stdin.write(packet('disabled')); await pause(60); assert.equal(signals.length, 2); assert.equal(observer.snapshot().connections.length, 0);
  observer.start(); existing.stdin.write(packet('enabled')); await until(() => signals.length === 3);
  assert.equal(signals[2]!.turnId, 'enabled'); assert.ok(diagnostics.entries.length === 0);
});

test('Observation preserves the stdin write receiver, overload arguments and return value, and removes its listeners', t => {
  const child = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true });
  cleanup(t, child);
  const writes: { receiver: Writable; args: unknown[] }[] = [];
  const originalWrite = function(this: Writable, ...args: unknown[]): boolean {
    writes.push({ receiver: this, args });
    return false;
  } as Writable['write'];
  child.stdin.write = originalWrite;
  const listenersBefore = [child.stdout.listenerCount('data'), child.stdout.listenerCount('end'), child.listenerCount('close')];
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }], () => {}, new Diagnostics());
  t.after(() => observer.dispose());
  observer.start();
  assert.equal(observer.snapshot().connections.length, 1);

  const receiver = new PassThrough();
  const callback = () => {};
  const text = '{"method":"unrelated"}\n';
  const bytes = Buffer.from(text);
  assert.equal(Reflect.apply(child.stdin.write, receiver, [text, 'utf8', callback]), false);
  assert.equal(Reflect.apply(child.stdin.write, child.stdin, [bytes, callback]), false);
  assert.deepEqual(writes, [
    { receiver, args: [text, 'utf8', callback] },
    { receiver: child.stdin, args: [bytes, callback] },
  ]);

  observer.stop();
  observer.stop();
  assert.equal(child.stdin.write, originalWrite);
  assert.deepEqual([child.stdout.listenerCount('data'), child.stdout.listenerCount('end'), child.listenerCount('close')], listenersBefore);
});

test('Malformed and oversized observations detach without killing, consuming, or changing the original child', async t => {
  const diagnostics = new Diagnostics(); const signals: Signal[] = [];
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }], signal => signals.push(signal), diagnostics);
  t.after(() => observer.dispose()); observer.start();
  const child = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, child);
  const output: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk));
  child.stdin.write(JSON.stringify({ raw: '{bad}\n' }) + '\n'); await until(() => observer.snapshot().connections.length === 0);
  assert.equal(child.killed, false); child.stdin.write(packet('after-error')); await until(() => Buffer.concat(output).includes(Buffer.from('after-error')));
  assert.equal(signals.length, 0); assert.match(diagnostics.entries[0]!.message, /stopped/);
  const large = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, large); large.stdout.resume();
  large.stdin.on('error', () => {});
  await new Promise<void>(resolve => large.stdin.write('x'.repeat(1024 * 1024 + 1), () => resolve()));
  assert.equal(large.killed, false); assert.equal(observer.snapshot().connections.length, 0);
  assert.match(diagnostics.entries.at(-1)!.message, /exceeds/);
});

test('Other processes are excluded; split UTF-8 frames are preserved', async t => {
  const signals: Signal[] = []; const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }], signal => signals.push(signal), new Diagnostics());
  t.after(() => observer.dispose()); observer.start();
  const other = spawn(process.execPath, [agent], { stdio: 'pipe', windowsHide: true }); cleanup(t, other);
  assert.equal(observer.snapshot().connections.length, 0);
  const child = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, child); child.stdout.resume();
  const bytes = Buffer.from(packet('split')); const split = bytes.indexOf(Buffer.from('한')) + 1;
  child.stdin.write(bytes.subarray(0, split)); child.stdin.write(bytes.subarray(split)); await until(() => signals.length === 1);
  assert.equal(signals[0]!.text, '한국어😀');
  await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); });
  assert.equal(observer.snapshot().connections.length, 0); assert.equal(observer.owns(signals[0]!), true);
  observer.stop(); assert.equal(observer.owns(signals[0]!), false);
});

test('The final result remains observable when the process exits before stdout is drained', async t => {
  const signals: Signal[] = [];
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }], s => signals.push(s), new Diagnostics());
  t.after(() => observer.dispose()); observer.start();
  const child = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true }); cleanup(t, child);
  child.stdout.pause();
  let resultCountAtExit = -1; let connectionsAtExit = -1;
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    resultCountAtExit = signals.length; connectionsAtExit = observer.snapshot().connections.length; resolve();
  }));
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdin.write(JSON.stringify({ events: events('final'), exit: true }) + '\n');
  await exited;
  assert.equal(resultCountAtExit, 0);
  assert.equal(connectionsAtExit, 1);
  child.stdout.resume(); await closed;
  assert.equal(signals.length, 1); assert.equal(signals[0]!.turnId, 'final');
  assert.equal(observer.snapshot().connections.length, 0); assert.equal(observer.owns(signals[0]!), true);
});

test('Existing Claude SDK JSON streams route actual results while leaving the original stream intact', async t => {
  const signals: Signal[] = []; const diagnostics = new Diagnostics();
  const child = spawn(process.execPath, [agent, '--output-format', 'stream-json', '--input-format', 'stream-json'], { windowsHide: true, stdio: 'pipe' }); cleanup(t, child);
  const bytes: Buffer[] = []; child.stdout.on('data', chunk => bytes.push(chunk));
  const observer = new AgentStreamObserver('window', () => [{ provider: 'claude', path: resolve('tests/fixtures') }], s => signals.push(s), diagnostics);
  t.after(() => observer.dispose()); observer.start(); assert.equal(observer.snapshot().connections.length, 1);
  const events = [{ type: 'system', subtype: 'init', session_id: 'session' },
    { type: 'assistant', session_id: 'session', message: { content: 'still running' } },
    { type: 'result', session_id: 'session', uuid: 'result', user_message_uuid: 'request', subtype: 'success', is_error: false, result: 'SDK_DONE' }];
  child.stdin.write(JSON.stringify({ type: 'user', uuid: 'request', events }) + '\n');
  await until(() => signals.length === 1); assert.equal(signals[0]!.text, 'SDK_DONE');
  assert.equal(signals[0]!.provider, 'claude'); assert.equal(diagnostics.entries.length, 0);
  assert.equal(Buffer.concat(bytes).toString('utf8'), events.map(e => JSON.stringify(e) + '\n').join(''));
});

test('Existing streams tolerate one initial partial frame, then detach on malformed JSON without changing bytes', async t => {
  const signals: Signal[] = [];
  const diagnostics = new Diagnostics();
  const child = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true });
  cleanup(t, child);
  const bytes: Buffer[] = [];
  child.stdout.on('data', chunk => bytes.push(chunk));
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }],
    signal => signals.push(signal), diagnostics);
  t.after(() => observer.dispose());
  observer.start();
  assert.equal(observer.snapshot().connections.length, 1);

  const partialFrame = '\npartial-json}\n\n';
  child.stdin.write(JSON.stringify({ raw: partialFrame }) + '\n');
  child.stdin.write(packet('after-partial'));
  await until(() => signals.length === 1);
  assert.equal(signals[0]!.turnId, 'after-partial');
  assert.equal(diagnostics.entries.length, 0);
  assert.equal(Buffer.concat(bytes).toString('utf8'), partialFrame + events('after-partial').map(event => JSON.stringify(event) + '\n').join(''));

  child.stdin.write(JSON.stringify({ raw: '{malformed}\n' }) + '\n');
  await until(() => observer.snapshot().connections.length === 0);
  assert.equal(child.killed, false);
  assert.match(diagnostics.entries[0]!.message, /stopped/);
});

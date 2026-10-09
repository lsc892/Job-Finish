import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AgentStreamObserver } from '../src/runtime/observe';
import { Diagnostics, Signal } from '../src/core/model';

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

test('Other processes and owned execution are excluded; split UTF-8 frames are preserved', async t => {
  const signals: Signal[] = []; const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }], signal => signals.push(signal), new Diagnostics());
  t.after(() => observer.dispose()); observer.start();
  const other = spawn(process.execPath, [agent], { stdio: 'pipe', windowsHide: true }); cleanup(t, other);
  const owned = spawn(process.execPath, [agent, 'app-server'], { stdio: 'pipe', windowsHide: true, env: { ...process.env, JOB_FINISH_OWNED_EXECUTION: '1' } }); cleanup(t, owned);
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

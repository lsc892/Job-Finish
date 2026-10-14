import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AgentStreamObserver } from '../src/runtime/observe';
import { Diagnostics, Signal } from '../src/core/model';
import { Notifications } from '../src/core/notifications';

const errorText = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again';
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('OAuth stdio fixture timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('OAuth refresh error reaches flash/toast before the real Claude stdio result without changing stream bytes', async t => {
  // Real child stdio and product delivery with mock Windows ports; no authenticated model or native banner.
  const child = spawn(process.execPath, [resolve('tests/fixtures/observed-agent.cjs'), '--output-format', 'stream-json'],
    { stdio: 'pipe', windowsHide: true });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); });
  });
  const received: Buffer[] = []; child.stdout.on('data', chunk => received.push(chunk));
  const originalWrite = child.stdin.write; const forwarded: unknown[][] = [];
  child.stdin.write = function (this: typeof child.stdin, ...args: unknown[]): boolean {
    forwarded.push(args); return Reflect.apply(originalWrite, this, args) as boolean;
  } as typeof child.stdin.write;
  const diagnostics = new Diagnostics(); const flashes: Signal[] = [];
  const toasts: { signal: Signal; text: string }[] = []; const deliveries: Promise<void>[] = [];
  const notifications = new Notifications({ focused: () => false, owns: signal => observer.owns(signal),
    flash: signal => flashes.push(signal), stopFlash: () => {}, activate: () => {},
    toast: async (signal, text, _click, allowed) => { if (allowed()) toasts.push({ signal, text }); },
  });
  const observer = new AgentStreamObserver('window', () => [{ provider: 'claude', path: resolve('tests/fixtures') }],
    signal => deliveries.push(notifications.deliver(signal)), diagnostics);
  t.after(() => observer.dispose()); observer.start();

  const assistant = { type: 'assistant', session_id: 'session', uuid: 'assistant-error', error: 'server_error',
    parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: errorText }] } };
  const firstEvents = [{ type: 'system', subtype: 'init', session_id: 'session' }, assistant];
  const first = Buffer.from(JSON.stringify({ type: 'user', uuid: 'request', session_id: 'session',
    message: { content: 'Fix login' }, events: firstEvents }) + '\n');
  child.stdin.write(first);
  await until(() => toasts.length === 1); await Promise.all(deliveries);
  assert.equal(forwarded[0]![0], first);
  assert.equal(flashes.length, 1); assert.equal(toasts[0]!.text, errorText);
  assert.equal(toasts[0]!.signal.status, 'error'); assert.equal(toasts[0]!.signal.title, 'Fix login');
  assert.equal(observer.snapshot().connections[0]!.activeTurns, 1);

  const finalEvents = [{ ...assistant, uuid: 'assistant-repeated' }, { type: 'result', session_id: 'session',
    uuid: 'failed-result', user_message_uuid: 'request', subtype: 'success', is_error: true, result: errorText }];
  child.stdin.write(JSON.stringify({ events: finalEvents }) + '\n');
  await until(() => observer.snapshot().connections[0]!.activeTurns === 0); await Promise.all(deliveries);
  assert.equal(toasts.length, 1); assert.equal(flashes.length, 1);
  assert.equal(Buffer.concat(received).toString('utf8'), [...firstEvents, ...finalEvents].map(frame => JSON.stringify(frame) + '\n').join(''));
  assert.equal(child.killed, false); assert.equal(diagnostics.entries.length, 0);
  observer.stop(); assert.equal(observer.owns(toasts[0]!.signal), false);
});

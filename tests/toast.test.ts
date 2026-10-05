// Real Windows pipe IO with a controlled helper process boundary; not a visual toast test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { WindowsToast, ToastProcessPorts } from '../src/windows/toast';
import { Diagnostics } from '../src/core/model';

const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error('Toast pipe timeout'); await pause(); } }
function setup(register: () => Promise<void> = async () => {}) {
  const launched: { args: string[]; pipe: string; process: EventEmitter; killed: boolean }[] = [];
  let clicks = 0; const diagnostics = new Diagnostics();
  const ports: ToastProcessPorts = { register, launch: (_binary, args) => {
    const process = new EventEmitter(); const item = { args, pipe: args[args.indexOf('-pipeName') + 1]!, process, killed: false };
    Object.assign(process, { kill: () => { item.killed = true; } }); launched.push(item); return process as ChildProcess;
  } };
  const toast = new WindowsToast('Code.exe', diagnostics, ports);
  const request = (id: string) => ({ notificationId: id, windowInstanceId: 'window', title: 'test', message: '😀'.repeat(200), appId: WindowsToast.appId, onClick: () => { clicks++; } });
  return { toast, launched, diagnostics, request, clicks: () => clicks };
}

test('Toast rechecks focus after registration and suppresses superseded or disposed requests', { skip: process.platform !== 'win32' }, async () => {
  let registered!: () => void; let allowed = true;
  const f = setup(() => new Promise(resolve => { registered = resolve; }));
  const first = f.toast.show(f.request('first')); const second = f.toast.show(f.request('second'), () => allowed);
  allowed = false; registered(); await Promise.all([first, second]); await pause();
  assert.equal(f.launched.length, 0); f.toast.dispose(); await f.toast.show(f.request('disposed')); assert.equal(f.launched.length, 0);
});

test('Toast click survives split UTF-16 bytes and helper exit, fires once, and bounds body length', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('split')); await until(() => f.launched.length === 1);
  const helper = f.launched[0]!; assert.equal(Array.from(helper.args[helper.args.indexOf('-m') + 1]!).length, 180);
  const socket = connect(helper.pipe); t.after(() => socket.destroy()); await new Promise<void>(resolve => socket.once('connect', resolve));
  helper.process.emit('exit', 0);
  const bytes = Buffer.from('notificationId=split;action=activated\0', 'utf16le');
  socket.write(bytes.subarray(0, 33)); await pause(); assert.equal(f.clicks(), 0); socket.end(bytes.subarray(33));
  await until(() => f.clicks() === 1); await pause(275); assert.equal(f.clicks(), 1); assert.equal(helper.killed, true);
});

test('Toast rejects a split action prefix and oversized callback; stale helper exit cannot clear the replacement', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('old')); await until(() => f.launched.length === 1);
  const first = f.launched[0]!; const socket = connect(first.pipe); t.after(() => socket.destroy()); await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write(Buffer.from('action=activate', 'utf16le')); await pause(30); assert.equal(f.clicks(), 0);
  socket.end(Buffer.from('Unrelated\0', 'utf16le')); await pause(30); assert.equal(f.clicks(), 0);
  await f.toast.show(f.request('new')); await until(() => f.launched.length === 2); const next = f.launched[1]!;
  first.process.emit('exit', 0); await pause(275); assert.equal(next.killed, false);
  const huge = connect(next.pipe); t.after(() => huge.destroy()); huge.on('error', () => {});
  await new Promise<void>(resolve => huge.once('connect', resolve)); huge.end(Buffer.alloc(9000));
  await until(() => f.diagnostics.entries.some(d => d.message.includes('8 KiB'))); assert.equal(f.clicks(), 0);
});

test('Toast records native unsigned error codes and registration failures permit a later retry', { skip: process.platform !== 'win32' }, async t => {
  let registrations = 0; const f = setup(async () => { if (++registrations === 1) throw new Error('Registration failed'); });
  t.after(() => f.toast.dispose()); await assert.rejects(() => f.toast.show(f.request('fail')), /Registration failed/);
  await f.toast.show(f.request('retry')); await until(() => f.launched.length === 1);
  f.launched[0]!.process.emit('exit', 4294967295); assert.equal(registrations, 2);
  assert.ok(f.diagnostics.entries.some(d => d.message.includes('4294967295')));
});

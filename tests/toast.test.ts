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
function setup(register: () => Promise<void> = async () => {}, notificationsEnabled = async () => true) {
  const launched: { args: string[]; pipe: string; process: EventEmitter; killed: boolean }[] = [];
  let clicks = 0; const diagnostics = new Diagnostics();
  const ports: ToastProcessPorts = { register, notificationsEnabled, launch: (_binary, args) => {
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

test('A helper click exit activates once even when no pipe callback arrives', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose());
  await f.toast.show(f.request('exit-click')); await until(() => f.launched.length === 1);
  f.launched[0]!.process.emit('exit', 0, null);
  await until(() => f.clicks() === 1);
  assert.equal(f.launched[0]!.killed, true);
  assert.equal(f.diagnostics.entries.length, 0);
});

test('A late pipe click wins over a pending exit check without double activation', { skip: process.platform !== 'win32' }, async t => {
  let finish!: (enabled: boolean) => void;
  const f = setup(undefined, () => new Promise<boolean>(resolve => { finish = resolve; })); t.after(() => f.toast.dispose());
  await f.toast.show(f.request('late')); await until(() => f.launched.length === 1);
  const helper = f.launched[0]!; helper.process.emit('exit', 0, null); await until(() => !!finish);
  const socket = connect(helper.pipe); t.after(() => socket.destroy());
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.end(Buffer.from('action=clicked;notificationId=late;', 'utf16le'));
  await until(() => f.clicks() === 1); finish(true); await until(() => helper.killed);
  assert.equal(f.clicks(), 1);
});

test('Failed Windows setting checks and invalid requests never activate a window', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(undefined, async () => { throw new Error('WinRT setting unavailable'); }); t.after(() => f.toast.dispose());
  for (const field of ['title', 'message']) await assert.rejects(f.toast.show({ ...f.request('empty'), [field]: ' ' }), /must not be empty/);
  assert.equal(f.launched.length, 0);
  await f.toast.show(f.request('setting-error')); await until(() => f.launched.length === 1);
  f.launched[0]!.process.emit('exit', 0, null); await until(() => f.launched[0]!.killed);
  assert.equal(f.clicks(), 0); assert.ok(f.diagnostics.entries.some(d => d.message.includes('WinRT setting unavailable')));
});

test('Exit fallback ignores disabled Windows notifications and all non-click outcomes', { skip: process.platform !== 'win32' }, async t => {
  let checks = 0;
  const f = setup(undefined, async () => { checks++; return false; }); t.after(() => f.toast.dispose());
  for (const code of [0, 1, 2, 3, 4, 5, -1, null]) {
    await f.toast.show(f.request(`exit-${code}`)); await until(() => f.launched.length > 0 && f.launched.at(-1)!.args.includes(`exit-${code}`));
    const helper = f.launched.at(-1)!; helper.process.emit('exit', code, code === null ? 'SIGTERM' : null);
    await until(() => helper.killed); assert.equal(f.clicks(), 0);
  }
  assert.equal(checks, 1, 'Only a click exit needs the Windows notification setting');
});

test('Pending exit fallback cannot activate a replaced, stopped or disposed notification', { skip: process.platform !== 'win32' }, async t => {
  for (const reason of ['replace', 'stop', 'dispose']) {
    let finish!: (enabled: boolean) => void;
    const f = setup(undefined, () => new Promise<boolean>(resolve => { finish = resolve; })); t.after(() => f.toast.dispose());
    await f.toast.show(f.request('old')); await until(() => f.launched.length === 1);
    f.launched[0]!.process.emit('exit', 0, null); await until(() => !!finish);
    if (reason === 'replace') { await f.toast.show(f.request('new')); await until(() => f.launched.length === 2); }
    else if (reason === 'stop') f.toast.stop(); else f.toast.dispose();
    finish(true); await pause(30);
    assert.equal(f.clicks(), 0, reason);
    if (reason === 'replace') assert.equal(f.launched[1]!.killed, false);
  }
});

test('Toast click survives split UTF-16 bytes and helper exit, fires once, and bounds body length', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('split')); await until(() => f.launched.length === 1);
  const helper = f.launched[0]!; assert.equal(Array.from(helper.args[helper.args.indexOf('-m') + 1]!).length, 180);
  const socket = connect(helper.pipe); t.after(() => socket.destroy()); await new Promise<void>(resolve => socket.once('connect', resolve));
  helper.process.emit('exit', 0);
  // SnoreToast's native pipe protocol uses "clicked"; node-notifier maps it to "activate".
  const bytes = Buffer.from('action=clicked;notificationId=split;pipe=test;application=;\0', 'utf16le');
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

test('Native clicked fields are exact, fire once, and ignore timeout or dismissal', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('native')); await until(() => f.launched.length === 1);
  const pipe = f.launched[0]!.pipe;
  for (const action of ['timedout', 'dismissed', 'clickedUnrelated']) {
    const socket = connect(pipe); t.after(() => socket.destroy());
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.end(Buffer.from(`notificationId=native;action=${action};`, 'utf16le'));
    await new Promise<void>(resolve => socket.once('close', resolve)); assert.equal(f.clicks(), 0);
  }
  const socket = connect(pipe); t.after(() => socket.destroy());
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write(Buffer.from('action=clicked', 'utf16le')); await pause(); assert.equal(f.clicks(), 0);
  socket.end(Buffer.from(';notificationId=native;action=clicked;\0', 'utf16le'));
  await until(() => f.clicks() === 1); await pause(); assert.equal(f.clicks(), 1);
});

test('Toast records native unsigned error codes and registration failures permit a later retry', { skip: process.platform !== 'win32' }, async t => {
  let registrations = 0; const f = setup(async () => { if (++registrations === 1) throw new Error('Registration failed'); });
  t.after(() => f.toast.dispose()); await assert.rejects(() => f.toast.show(f.request('fail')), /Registration failed/);
  await f.toast.show(f.request('retry')); await until(() => f.launched.length === 1);
  f.launched[0]!.process.emit('exit', 4294967295); assert.equal(registrations, 2);
  assert.ok(f.diagnostics.entries.some(d => d.message.includes('4294967295')));
});

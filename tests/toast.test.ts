// Real Windows pipe IO with a controlled native sender boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { connect, Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { WindowsToast, ToastProcessPorts } from '../src/windows/toast';
import { Diagnostics } from '../src/core/model';

const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error('Native toast pipe timeout'); await pause(); } }
function setup(exitCode = 0, options: { registrationFailures?: number; holdRegistration?: boolean; delivery?: 'silent' | 'failed' | 'history-error' } = {}) {
  const launched: { args: string[]; payload: Record<string, unknown>; child: EventEmitter; killed: boolean }[] = [];
  const diagnostics = new Diagnostics(); let clicks = 0; let allowed = true;
  let registrations = 0; let releaseRegistration: (() => void) | undefined;
  const ports: ToastProcessPorts = { launch: (_binary, args) => {
    const child = new EventEmitter(); const stdin = new PassThrough(); const stderr = new PassThrough(); const stdout = new PassThrough();
    const item = { args, payload: {} as Record<string, unknown>, child, killed: false };
    const register = args[0] === '--register';
    if (register) registrations++; else launched.push(item);
    let input = ''; stdin.on('data', (chunk: Buffer) => { input += chunk.toString('utf8'); });
    const finish = () => {
      if (item.killed) return;
      if (register) {
        const code = registrations <= (options.registrationFailures ?? 0) ? 1 : 0;
        if (code) stderr.write('Registration failed');
        else stdout.write(JSON.stringify({ event: 'toast.registration.ready', appId: WindowsToast.appId, changed: false, setting: 'Enabled' }) + '\n');
        child.emit('close', code, null); return;
      }
      if (exitCode) stderr.write('Native sender failed');
      // Include a diagnostic arriving after exit but before close, as real stdio can do.
      child.emit('exit', exitCode, null);
      const send = (name: string, fields = {}) => stdout.write(JSON.stringify({ event: name, notificationId: item.payload.notificationId, windowInstanceId: item.payload.windowInstanceId, ...fields }) + '\n');
      if (options.delivery !== 'silent') {
        send('toast.submitted');
        if (options.delivery === 'failed') send('toast.failed', { errorCode: '0x80070005' });
        else {
          send(options.delivery === 'history-error' ? 'toast.history.error' : 'toast.history.confirmed', { errorCode: options.delivery === 'history-error' ? '0x80004005' : null });
          send('toast.observation.complete', { historyConfirmed: options.delivery !== 'history-error', notificationState: 1, bannerVerified: false });
        }
      }
      child.emit('close', exitCode, null);
    };
    stdin.on('finish', () => {
      if (!register) item.payload = JSON.parse(input);
      if (register && options.holdRegistration) releaseRegistration = finish;
      else setImmediate(finish);
    });
    Object.assign(child, { stdin, stderr, stdout, kill: () => { item.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); } });
    return child as ChildProcess;
  } };
  const toast = new WindowsToast('JobFinish.Native.exe', diagnostics, ports);
  const request = (id: string) => ({ notificationId: id, windowInstanceId: 'window-A', title: 'test', message: '한글😀'.repeat(100), appId: WindowsToast.appId,
    target: { hwnd: '123456', pid: 42, executable: 'C:\\Code.exe' }, canActivate: () => allowed, onClick: () => { clicks++; } });
  return { toast, launched, diagnostics, request, clicks: () => clicks, deny: () => { allowed = false; }, registrations: () => registrations, releaseRegistration: () => releaseRegistration?.() };
}
async function client(pipe: unknown): Promise<Socket> {
  const socket = connect(`\\\\.\\pipe\\${String(pipe)}`); socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}
const event = (notificationId: string, name: string, fields: Record<string, unknown> = {}) => JSON.stringify({ event: name, notificationId, windowInstanceId: 'window-A', ...fields }) + '\n';
async function authorize(socket: Socket, notificationId: string): Promise<boolean> {
  const reply = new Promise<boolean>(resolve => socket.once('data', chunk => resolve(JSON.parse(chunk.toString('utf8')).allowed === true)));
  socket.write(event(notificationId, 'toast.click')); return reply;
}

test('Native toast preserves UTF-8 and exact HWND, bounds displayed text, and sender exit never implies click', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('native'));
  const sent = f.launched[0]!;
  assert.deepEqual(sent.args, ['--show']); assert.deepEqual(sent.payload.target, f.request('native').target);
  assert.ok(String(sent.payload.message).startsWith('한글😀')); assert.equal(Array.from(String(sent.payload.message)).length, 180);
  assert.equal(f.clicks(), 0); assert.equal(f.diagnostics.entries.length, 0);
  const socket = await client(sent.payload.pipe); t.after(() => socket.destroy());
  assert.equal(await authorize(socket, 'native'), true, 'protocol pipe remains available after sender exit');
  socket.write(event('native', 'window.activation.result', { activated: true, hwnd: '123456', foreground: '123456' }));
  await until(() => f.clicks() === 1);
  assert.equal(f.diagnostics.events.find(entry => entry.event === 'window.activation.result')?.activated, true);
});

test('Native toast suppresses unfocused-policy failures and disposed requests before launching', { skip: process.platform !== 'win32' }, async () => {
  const f = setup(); await f.toast.show(f.request('focused'), () => false); assert.equal(f.launched.length, 0);
  f.toast.dispose(); await f.toast.show(f.request('disposed')); assert.equal(f.launched.length, 0);
});

test('Invalid requests and native sender errors fail without inferring activation', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(1); t.after(() => f.toast.dispose());
  for (const field of ['title', 'message']) await assert.rejects(f.toast.show({ ...f.request('empty'), [field]: ' ' }), /must not be empty/);
  await assert.rejects(f.toast.show({ ...f.request('wrong-app'), appId: 'Other.App' }), /registered application/);
  assert.equal(f.launched.length, 0);
  await assert.rejects(f.toast.show(f.request('sender-error')), /Native sender failed/); assert.equal(f.clicks(), 0);
});

test('Native click authorization checks current ownership independently from show focus policy', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('owned'));
  f.deny(); const socket = await client(f.launched[0]!.payload.pipe); t.after(() => socket.destroy());
  assert.equal(await authorize(socket, 'owned'), false); assert.equal(f.clicks(), 0);
  assert.equal(f.diagnostics.events.some(entry => entry.event === 'window.activation.request'), false);
});

test('Native results require matching IDs and the authorized socket, and duplicate clicks cannot focus twice', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('verified'));
  const pipe = f.launched[0]!.payload.pipe;
  const wrong = await client(pipe); t.after(() => wrong.destroy());
  const closed = new Promise<void>(resolve => wrong.once('close', resolve)); wrong.write(event('wrong-id', 'toast.click')); await closed;
  const unsolicited = await client(pipe); t.after(() => unsolicited.destroy());
  unsolicited.write(event('verified', 'window.activation.result', { activated: true })); await pause(30); assert.equal(f.clicks(), 0);
  const authorized = await client(pipe); t.after(() => authorized.destroy()); assert.equal(await authorize(authorized, 'verified'), true);
  assert.equal(await authorize(unsolicited, 'verified'), false);
  authorized.write(event('verified', 'window.activation.result', { activated: true }) + event('verified', 'window.activation.result', { activated: true }));
  await until(() => f.clicks() === 1); await pause(30); assert.equal(f.clicks(), 1);
});

test('Native UTF-8 frames survive chunk boundaries and failed focus remains a failed result', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('split'));
  const socket = await client(f.launched[0]!.payload.pipe); t.after(() => socket.destroy());
  const bytes = Buffer.from(event('split', 'toast.click', { verifier: '한글😀' }), 'utf8');
  const boundary = bytes.indexOf(Buffer.from('한')) + 1;
  const reply = new Promise<boolean>(resolve => socket.once('data', chunk => resolve(JSON.parse(chunk.toString()).allowed)));
  socket.write(bytes.subarray(0, boundary)); await pause(20); assert.equal(f.clicks(), 0);
  socket.write(bytes.subarray(boundary)); assert.equal(await reply, true);
  socket.write(event('split', 'window.activation.result', { activated: false, reason: 'foreground-refused', hwnd: '123456', foreground: '222222' }));
  await until(() => f.clicks() === 1);
  assert.equal(f.diagnostics.events.find(entry => entry.event === 'window.activation.result')?.activated, false);
  assert.ok(f.diagnostics.entries.some(entry => entry.message.includes('foreground-refused')));
});

test('Replacing or stopping a toast closes its authorization channel and rejects oversized callbacks', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.toast.dispose()); await f.toast.show(f.request('old'));
  const old = await client(f.launched[0]!.payload.pipe); t.after(() => old.destroy());
  const closed = new Promise<void>(resolve => old.once('close', resolve)); await f.toast.show(f.request('new')); await closed;
  const next = await client(f.launched[1]!.payload.pipe); t.after(() => next.destroy()); next.write('x'.repeat(9000));
  await until(() => f.diagnostics.entries.some(entry => entry.message.includes('8 KiB'))); assert.equal(f.clicks(), 0);
  const last = await client(f.launched[1]!.payload.pipe); t.after(() => last.destroy());
  const stopped = new Promise<void>(resolve => last.once('close', resolve)); f.toast.stop(); await stopped;
  assert.equal(f.clicks(), 0);
});

test('Startup and concurrent notifications share registration, and the newest notification wins', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(0, { holdRegistration: true }); t.after(() => f.toast.dispose());
  const startup = f.toast.initialize(); const old = f.toast.show(f.request('old')); const next = f.toast.show(f.request('next'));
  await pause(); assert.equal(f.registrations(), 1); assert.equal(f.launched.length, 0);
  f.releaseRegistration(); await Promise.all([startup, old, next]);
  assert.deepEqual(f.launched.map(item => item.payload.notificationId), ['next']);
  await f.toast.show(f.request('later')); assert.equal(f.registrations(), 1);
});

test('Registration failures retry on the next attempt without starting a sender', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(0, { registrationFailures: 1 }); t.after(() => f.toast.dispose());
  await assert.rejects(f.toast.show(f.request('first')), /Registration failed/); assert.equal(f.launched.length, 0);
  await f.toast.show(f.request('retry')); assert.equal(f.registrations(), 2); assert.equal(f.launched.length, 1);
});

test('Focus and cancellation are rechecked after asynchronous registration', { skip: process.platform !== 'win32' }, async t => {
  for (const action of ['focus', 'stop', 'dispose']) {
    const f = setup(0, { holdRegistration: true }); t.after(() => f.toast.dispose()); let allowed = true;
    const result = f.toast.show(f.request(action), () => allowed);
    // Observe a disposal rejection immediately so it cannot become unhandled.
    const completion = result.catch(error => { if (action !== 'dispose') throw error; });
    await pause();
    if (action === 'focus') allowed = false;
    else if (action === 'stop') f.toast.stop(); else f.toast.dispose();
    f.releaseRegistration(); await completion; assert.equal(f.launched.length, 0);
  }
});

test('A zero exit cannot replace delivery diagnostics; failed events survive stdout after exit', { skip: process.platform !== 'win32' }, async t => {
  for (const delivery of ['silent', 'failed'] as const) {
    const f = setup(0, { delivery }); t.after(() => f.toast.dispose());
    await assert.rejects(f.toast.show(f.request(delivery)), /delivery was not confirmed/);
    assert.equal(f.diagnostics.events.some(event => event.event === 'toast.registered'), false);
    if (delivery === 'failed') assert.equal(f.diagnostics.events.find(event => event.event === 'toast.failed')?.errorCode, '0x80070005');
  }
});

test('History observation and successful submission do not claim a visible banner', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(0, { delivery: 'history-error' }); t.after(() => f.toast.dispose());
  await f.toast.show(f.request('unconfirmed'));
  const observed = f.diagnostics.events.find(event => event.event === 'toast.observation.complete');
  assert.equal(observed?.historyConfirmed, false); assert.equal(observed?.bannerVerified, false);
  assert.equal(observed?.notificationState, 1);
});

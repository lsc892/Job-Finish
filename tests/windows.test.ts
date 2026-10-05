import test from 'node:test';
import assert from 'node:assert/strict';
import { FlashClock, FlashController } from '../src/windows/flash';
import { NativeApi, NativeWindow, Win32, WindowBinding, WindowIdentity } from '../src/windows/native';
import { Notifications } from '../src/core/notifications';
import { binding } from './helpers';
import { Signal } from '../src/core/model';

test('The master switch suppresses delivery immediately, including a toast still being registered', async () => {
  let enabled = true; let flashes = 0; let allowed!: () => boolean;
  const notifications = new Notifications({ enabled: () => enabled, focused: () => false, owns: () => true,
    stopFlash: () => {}, flash: () => { flashes++; }, activate: () => {}, toast: async (_signal, _text, _click, canShow) => { allowed = canShow; } });
  const signal: Signal = { ...binding(), notificationId: 'n', turnId: 't', status: 'completed', text: 'done', truncated: false, at: '' };
  await notifications.deliver(signal); assert.equal(allowed(), true); enabled = false; assert.equal(allowed(), false);
  await notifications.deliver(signal); assert.equal(flashes, 1); assert.equal(notifications.results.length, 2);
});

class FakeNative implements NativeApi {
  input = 1;
  lastInput(): number { return this.input; }
  front = 2n; windows = new Map<bigint, NativeWindow>([1n, 2n].map(hwnd => [hwnd, { hwnd, pid: 123, title: 'same folder - Code', executable: 'C:\\Code.exe' }]));
  calls: unknown[][] = [];
  foreground(): bigint { return this.front; }
  inspect(hwnd: bigint): NativeWindow | undefined { return this.windows.get(hwnd); }
  activate(hwnd: bigint): boolean { this.calls.push(['activate', hwnd]); this.front = hwnd; return true; }
  flash(hwnd: bigint, invert: boolean): void { this.calls.push(['flash', hwnd, invert]); }
  flashEx(hwnd: bigint, flags: number): void { this.calls.push(['ex', hwnd, flags]); }
}
function setup() {
  const native = new FakeNative(); let focused = false; let now = 0;
  const timers = new Set<() => void>();
  const time: FlashClock = { now: () => now, every: fn => { timers.add(fn); return fn; }, clear: fn => timers.delete(fn as () => void) };
  const flash = new FlashController(native, () => focused, time);
  const window: WindowBinding = { ...native.inspect(1n)!, windowInstanceId: 'A', verifiedAt: '', method: 'focused-observation' };
  return { native, timers, flash, window, focus: () => { focused = true; }, tick: (ms = 500) => { now += ms; [...timers].forEach(fn => fn()); } };
}
test('Only bound HWND flashes; replacement maintains one timer and stale clicks cannot stop new alert', () => {
  const f = setup(); f.flash.start(f.window, 'first', 'manual', 300_000); f.tick();
  assert.deepEqual(f.native.calls[0], ['flash', 1n, true]); assert.ok(f.native.calls.every(c => c[1] === 1n));
  f.flash.start(f.window, 'second', 'manual', 300_000); assert.equal(f.timers.size, 1);
  f.flash.stop('first'); assert.equal(f.flash.activeNotificationId, 'second');
  f.flash.stop('second'); assert.equal(f.timers.size, 0); assert.deepEqual(f.native.calls.at(-1), ['ex', 1n, 0]);
});
test('Focus, expiry, disposal and invalid PID stop and clean flash', () => {
  for (const reason of ['focus', 'expiry', 'disposed', 'pid']) {
    const f = setup(); f.flash.start(f.window, 'n', 'manual', 1000);
    if (reason === 'focus') f.focus();
    if (reason === 'disposed') f.flash.dispose();
    if (reason === 'pid') f.native.windows.set(1n, { ...f.window, pid: 999 });
    f.tick(1001); assert.equal(f.timers.size, 0, reason);
  }
});
test('System flash never calls manual invert, and foreground is checked before start', () => {
  const f = setup(); f.flash.start(f.window, 'n', 'system', 0); f.tick();
  assert.deepEqual(f.native.calls, [['ex', 1n, 14]]); f.flash.stop();
  f.native.calls = []; f.native.front = 1n; f.flash.start(f.window, 'n2', 'manual', 0); assert.equal(f.native.calls.length, 0);
});
test('Same title and PID windows bind from stable focus; fast switches remain unbound', async () => {
  const native = new FakeNative(); native.front = 1n;
  const a = new WindowIdentity('A', native, () => true, 'C:\\Code.exe');
  assert.equal(await a.observe(), true); assert.equal(a.binding?.hwnd, 1n);
  native.front = 2n; const b = new WindowIdentity('B', native, () => true, 'C:\\Code.exe');
  const pending = b.observe(); native.front = 1n; b.changed(); assert.equal(await pending, false); assert.equal(b.binding, undefined);
  native.front = 2n; assert.equal(await b.observe(), true); assert.equal(b.valid()?.hwnd, 2n);
});

test('Toast activation uses the verified window, rejecting missing, closed or reused HWNDs', async () => {
  const native = new FakeNative(); native.front = 1n;
  const identity = new WindowIdentity('A', native, () => true, 'C:\\Code.exe');
  assert.equal(identity.activate(), false);
  assert.equal(await identity.observe(), true);
  native.front = 2n; assert.equal(identity.activate(), true);
  assert.equal(native.foreground(), 1n); assert.deepEqual(native.calls, [['activate', 1n]]);
  for (const reason of ['closed', 'pid', 'executable']) {
    native.windows.set(1n, { hwnd: 1n, pid: 123, title: 'changed title', executable: 'C:\\Code.exe' });
    native.front = 1n; assert.equal(await identity.observe(), true);
    native.calls = []; native.front = 2n;
    if (reason === 'closed') native.windows.delete(1n);
    else native.windows.set(1n, { ...native.windows.get(1n)!, ...(reason === 'pid' ? { pid: 999 } : { executable: 'C:\\Other.exe' }) });
    assert.equal(identity.activate(), false, reason); assert.equal(native.calls.length, 0, reason);
    assert.equal(identity.binding, undefined, reason);
  }
});

test('Click stops its flash and activates the originating window only while delivery remains owned and enabled', async () => {
  let enabled = true; let owns = true; let click!: () => void; const calls: string[] = [];
  const notifications = new Notifications({ enabled: () => enabled, focused: () => false, owns: () => owns,
    stopFlash: id => { calls.push(`stop:${id}`); }, flash: () => {},
    activate: signal => { calls.push(`activate:${signal.windowInstanceId}`); },
    toast: async (_signal, _message, onClick) => { click = onClick; } });
  const signal: Signal = { ...binding(), notificationId: 'n', turnId: 't', status: 'completed', text: 'done', truncated: false, at: '' };
  await notifications.deliver(signal); click();
  assert.deepEqual(calls, ['stop:n', `activate:${signal.windowInstanceId}`]);
  calls.length = 0; owns = false; click(); assert.deepEqual(calls, ['stop:n']);
  calls.length = 0; owns = true; enabled = false; click(); assert.deepEqual(calls, ['stop:n']);
});

test('Toast focus retries a refused or not-yet-completed activation and verifies the foreground', async () => {
  const native = new FakeNative(); const identity = new WindowIdentity('A', native, () => false, 'C:\\Code.exe');
  identity.binding = { ...native.inspect(1n)!, windowInstanceId: 'A', verifiedAt: '', method: 'focused-observation' };
  let attempts = 0;
  native.activate = hwnd => { if (++attempts === 3) native.front = hwnd; return attempts !== 1; };
  assert.equal(await identity.activateWithRetry(), true);
  assert.equal(attempts, 3); assert.equal(native.front, 1n);
});

test('Toast focus retries stop on new input, lost ownership, disposal, cancellation or an invalid target', async () => {
  for (const reason of ['input', 'ownership', 'dispose', 'cancel', 'pid']) {
    const native = new FakeNative(); const identity = new WindowIdentity('A', native, () => false, 'C:\\Code.exe');
    identity.binding = { ...native.inspect(1n)!, windowInstanceId: 'A', verifiedAt: '', method: 'focused-observation' };
    let attempts = 0; let allowed = true;
    native.activate = () => { attempts++; return false; };
    const pending = identity.activateWithRetry(() => allowed);
    if (reason === 'input') native.input++;
    if (reason === 'ownership') allowed = false;
    if (reason === 'dispose') identity.dispose();
    if (reason === 'cancel') identity.cancelActivation();
    if (reason === 'pid') native.windows.set(1n, { ...native.windows.get(1n)!, pid: 999 });
    assert.equal(await pending, false, reason); assert.equal(attempts, 1, reason);
  }
});

test('Toast focus retries are bounded when Windows keeps refusing foreground activation', async () => {
  const native = new FakeNative(); const identity = new WindowIdentity('A', native, () => false, 'C:\\Code.exe');
  identity.binding = { ...native.inspect(1n)!, windowInstanceId: 'A', verifiedAt: '', method: 'focused-observation' };
  let attempts = 0; native.activate = () => { attempts++; return false; };
  assert.equal(await identity.activateWithRetry(), false); assert.equal(attempts, 4);
});

test('A newer activation cancels old retries and unavailable input tracking disables retries', async () => {
  const native = new FakeNative(); const identity = new WindowIdentity('A', native, () => false, 'C:\\Code.exe');
  identity.binding = { ...native.inspect(1n)!, windowInstanceId: 'A', verifiedAt: '', method: 'focused-observation' };
  let attempts = 0; native.activate = hwnd => { if (++attempts === 2) native.front = hwnd; return false; };
  const first = identity.activateWithRetry();
  assert.equal(await identity.activateWithRetry(), true); assert.equal(await first, false); assert.equal(attempts, 2);
  native.front = 2n; attempts = 0; native.activate = () => { attempts++; return false; };
  Object.assign(native, { lastInput: () => undefined });
  assert.equal(await identity.activateWithRetry(), false); assert.equal(attempts, 1);
});

function activationBoundary(options: { minimized?: boolean; direct?: boolean; attached?: boolean; retry?: boolean | Error } = {}) {
  const calls: unknown[][] = []; let attempts = 0;
  // Replace only the FFI boundary so these cases never move a real desktop window.
  const native = Object.assign(Object.create(Win32.prototype), {
    isWindow: () => 1, isIconic: () => options.minimized ? 1 : 0,
    showWindowAsync: (hwnd: bigint, mode: number) => { calls.push(['restore', hwnd, mode]); return 1; },
    setForeground: (hwnd: bigint) => {
      calls.push(['foreground', hwnd]);
      if (++attempts === 1) return options.direct ? 1 : 0;
      if (options.retry instanceof Error) throw options.retry;
      return options.retry === false ? 0 : 1;
    },
    getForeground: () => 2n, currentThread: () => 10, getPid: () => 20,
    peekMessage: () => 0,
    attachInput: (from: number, to: number, attach: number) => {
      calls.push(['attach', from, to, attach]); return options.attached === false ? 0 : 1;
    },
  }) as Win32;
  return { native, calls };
}

test('Window activation restores minimized windows and preserves the layout of visible windows', () => {
  for (const minimized of [false, true]) {
    const f = activationBoundary({ minimized, direct: true }); assert.equal(f.native.activate(1n), true);
    assert.deepEqual(f.calls, minimized ? [['restore', 1n, 9], ['foreground', 1n]] : [['foreground', 1n]]);
  }
});

test('Foreground retry releases its input attachment after success, refusal or an exception', () => {
  for (const retry of [true, false, new Error('Native focus failed')]) {
    const f = activationBoundary({ retry });
    if (retry instanceof Error) assert.throws(() => f.native.activate(1n), /Native focus failed/);
    else assert.equal(f.native.activate(1n), retry);
    assert.deepEqual(f.calls.at(-1), ['attach', 10, 20, 0]);
  }
  const denied = activationBoundary({ attached: false }); assert.equal(denied.native.activate(1n), false);
  assert.equal(denied.calls.filter(call => call[0] === 'foreground').length, 1);
});
test('Notification policy stores focused results, rechecks ownership and bounds result count', async () => {
  let focused = true; let owns = true; const calls: string[] = [];
  const notifications = new Notifications({ focused: () => focused, owns: () => owns, stopFlash: () => { calls.push('stop'); }, flash: () => { calls.push('flash'); }, activate: () => {}, toast: async (_s, message, _click, allowed) => { assert.ok(Array.from(message).length <= 180); if (allowed()) calls.push('toast'); } });
  const signal: Signal = { ...binding(), notificationId: 'n', turnId: 't', status: 'completed', text: 'x'.repeat(300), truncated: false, at: '' };
  await notifications.deliver(signal); assert.deepEqual(calls, ['stop']);
  focused = false; await notifications.deliver(signal); assert.deepEqual(calls, ['stop', 'flash', 'toast']);
  owns = false; await notifications.deliver(signal); assert.equal(notifications.results.length, 2);
  owns = true; for (let i = 0; i < 25; i++) await notifications.deliver(signal); assert.equal(notifications.results.length, 20);
});
test('Win32 native ABI and read-only foreground inspection', { skip: process.platform !== 'win32' }, () => {
  const native = new Win32(); assert.equal(native.structSize, process.arch === 'ia32' ? 20 : 32);
  assert.equal(typeof native.foreground(), 'bigint'); assert.equal(native.inspect(0n), undefined);
  assert.equal(typeof native.lastInput(), 'number');
  assert.equal(native.activate(0n), false);
});

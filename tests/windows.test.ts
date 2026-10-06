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
  front = 2n; windows = new Map<bigint, NativeWindow>([1n, 2n].map(hwnd => [hwnd, { hwnd, pid: 123, title: 'same folder - Code', executable: 'C:\\Code.exe' }]));
  calls: unknown[][] = [];
  foreground(): bigint { return this.front; }
  inspect(hwnd: bigint): NativeWindow | undefined { return this.windows.get(hwnd); }
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

test('Observed HWND bindings reject missing, closed or reused windows before native delivery', async () => {
  const native = new FakeNative(); native.front = 1n;
  const identity = new WindowIdentity('A', native, () => true, 'C:\\Code.exe');
  assert.equal(identity.valid(), undefined);
  assert.equal(await identity.observe(), true);
  native.front = 2n; assert.equal(identity.valid()?.hwnd, 1n);
  assert.equal(native.foreground(), 2n); assert.deepEqual(native.calls, []);
  for (const reason of ['closed', 'pid', 'executable']) {
    native.windows.set(1n, { hwnd: 1n, pid: 123, title: 'changed title', executable: 'C:\\Code.exe' });
    native.front = 1n; assert.equal(await identity.observe(), true);
    native.calls = []; native.front = 2n;
    if (reason === 'closed') native.windows.delete(1n);
    else native.windows.set(1n, { ...native.windows.get(1n)!, ...(reason === 'pid' ? { pid: 999 } : { executable: 'C:\\Other.exe' }) });
    assert.equal(identity.valid(), undefined, reason); assert.equal(native.calls.length, 0, reason);
    assert.equal(identity.binding, undefined, reason);
  }
});

test('HWND observation waits for the native transition after an early VS Code focus event', async () => {
  const native = new FakeNative(); native.front = 3n;
  native.windows.set(3n, { hwnd: 3n, pid: 321, title: 'Other app', executable: 'C:\\Other.exe' });
  const identity = new WindowIdentity('A', native, () => true, 'C:\\Code.exe');
  const observed = identity.observe();
  const transition = setTimeout(() => { native.front = 1n; }, 100);
  try { assert.equal(await observed, true); assert.equal(identity.binding?.hwnd, 1n); }
  finally { clearTimeout(transition); identity.dispose(); }
});

test('An initial stale focus flag cannot bind a previous Code window after focus is lost', async () => {
  const native = new FakeNative(); let focused = true;
  const identity = new WindowIdentity('A', native, () => focused, 'C:\\Code.exe');
  const observed = identity.observe();
  const transition = setTimeout(() => { focused = false; identity.changed(); }, 100);
  try { assert.equal(await observed, false); assert.equal(identity.binding, undefined); }
  finally { clearTimeout(transition); identity.dispose(); }
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
});

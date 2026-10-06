type Koffi = typeof import('koffi', { with: { 'resolution-mode': 'import' } });
import { resolve } from 'node:path';

export interface NativeWindow { hwnd: bigint; pid: number; title: string; executable: string }
export interface NativeApi {
  foreground(): bigint;
  lastInput(): number | undefined;
  inspect(hwnd: bigint): NativeWindow | undefined;
  activate(hwnd: bigint): boolean;
  flash(hwnd: bigint, invert: boolean): void;
  flashEx(hwnd: bigint, flags: number): void;
}
export class Win32 implements NativeApi {
  private readonly koffi: Koffi = require('koffi');
  private readonly user = this.koffi.load('user32.dll');
  private readonly kernel = this.koffi.load('kernel32.dll');
  private readonly getForeground = this.user.func('__stdcall', 'GetForegroundWindow', 'uintptr_t', []);
  private readonly setForeground = this.user.func('__stdcall', 'SetForegroundWindow', 'int32', ['uintptr_t']);
  private readonly isIconic = this.user.func('__stdcall', 'IsIconic', 'int32', ['uintptr_t']);
  private readonly showWindowAsync = this.user.func('__stdcall', 'ShowWindowAsync', 'int32', ['uintptr_t', 'int32']);
  private readonly attachInput = this.user.func('__stdcall', 'AttachThreadInput', 'int32', ['uint32', 'uint32', 'int32']);
  private readonly peekMessage = this.user.func('__stdcall', 'PeekMessageW', 'int32', ['void *', 'uintptr_t', 'uint32', 'uint32', 'uint32']);
  private readonly currentThread = this.kernel.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
  private readonly getLastInput = this.user.func('__stdcall', 'GetLastInputInfo', 'int32', ['void *']);
  private readonly isWindow = this.user.func('__stdcall', 'IsWindow', 'int32', ['uintptr_t']);
  private readonly visible = this.user.func('__stdcall', 'IsWindowVisible', 'int32', ['uintptr_t']);
  private readonly getPid = this.user.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['uintptr_t', this.koffi.out(this.koffi.pointer('uint32'))]);
  private readonly getTitle = this.user.func('__stdcall', 'GetWindowTextW', 'int32', ['uintptr_t', 'void *', 'int32']);
  private readonly openProcess = this.kernel.func('__stdcall', 'OpenProcess', 'uintptr_t', ['uint32', 'int32', 'uint32']);
  private readonly closeHandle = this.kernel.func('__stdcall', 'CloseHandle', 'int32', ['uintptr_t']);
  private readonly imageName = this.kernel.func('__stdcall', 'QueryFullProcessImageNameW', 'int32', ['uintptr_t', 'uint32', 'void *', this.koffi.inout(this.koffi.pointer('uint32'))]);
  private readonly flashWindow = this.user.func('__stdcall', 'FlashWindow', 'int32', ['uintptr_t', 'int32']);
  private readonly enumCallback = this.koffi.proto('__stdcall', 'int32', ['uintptr_t', 'intptr_t']);
  private readonly enumWindows = this.user.func('__stdcall', 'EnumWindows', 'int32', [this.koffi.pointer(this.enumCallback), 'intptr_t']);
  private readonly info = this.koffi.struct({ cbSize: 'uint32', hwnd: 'uintptr_t', dwFlags: 'uint32', uCount: 'uint32', dwTimeout: 'uint32' });
  private readonly flashWindowEx = this.user.func('__stdcall', 'FlashWindowEx', 'int32', [this.koffi.pointer(this.info)]);
  readonly structSize = this.koffi.sizeof(this.info);
  foreground(): bigint { return BigInt(this.getForeground()); }
  lastInput(): number | undefined {
    const info = Buffer.alloc(8); info.writeUInt32LE(8);
    return this.getLastInput(info) ? info.readUInt32LE(4) : undefined;
  }
  activate(hwnd: bigint): boolean {
    if (!hwnd || !this.isWindow(hwnd)) return false;
    // Restore only minimized windows, preserving a maximized window's layout.
    if (this.isIconic(hwnd)) this.showWindowAsync(hwnd, 9 /* SW_RESTORE */);
    if (this.setForeground(hwnd)) return true;
    if (this.foreground() === hwnd) return true;
    // The Extension Host has no focused UI thread. On an explicit toast click,
    // briefly share the foreground input queue, then always detach it.
    const thread = this.currentThread(); const pid = [0];
    const foregroundThread = this.getPid(this.foreground(), pid);
    if (!foregroundThread || foregroundThread === thread) return false;
    this.peekMessage(Buffer.alloc(64), 0, 0, 0, 0 /* PM_NOREMOVE: create an input queue */);
    if (!this.attachInput(thread, foregroundThread, 1)) return false;
    try { return !!this.setForeground(hwnd); }
    finally { this.attachInput(thread, foregroundThread, 0); }
  }
  enumerate(includeHidden = false): NativeWindow[] {
    const windows: NativeWindow[] = [];
    const callback = this.koffi.register((hwnd: number | bigint) => { const window = this.inspect(BigInt(hwnd), includeHidden); if (window) windows.push(window); return 1; }, this.koffi.pointer(this.enumCallback));
    try { this.enumWindows(callback, 0); } finally { this.koffi.unregister(callback); }
    return windows;
  }
  inspect(hwnd: bigint, includeHidden = false): NativeWindow | undefined {
    if (!hwnd || !this.isWindow(hwnd) || (!includeHidden && !this.visible(hwnd))) return undefined;
    const pid = [0]; this.getPid(hwnd, pid);
    const process = this.openProcess(0x1000, 0, pid[0]); if (!process) return undefined;
    try {
      const size = [32768]; const path = Buffer.alloc(65536);
      if (!this.imageName(process, 0, path, size)) return undefined;
      const title = Buffer.alloc(4096); const length = this.getTitle(hwnd, title, 2048);
      return { hwnd, pid: pid[0]!, title: title.subarray(0, length * 2).toString('utf16le'), executable: path.subarray(0, size[0]! * 2).toString('utf16le') };
    } finally { this.closeHandle(process); }
  }
  flash(hwnd: bigint, invert: boolean): void { this.flashWindow(hwnd, invert ? 1 : 0); }
  flashEx(hwnd: bigint, flags: number): void {
    // Return value is the previous active state, not success/failure.
    this.flashWindowEx({ cbSize: this.structSize, hwnd, dwFlags: flags, uCount: 0, dwTimeout: 0 });
  }
}
export interface WindowBinding extends NativeWindow { windowInstanceId: string; verifiedAt: string; method: 'focused-observation' }
export class WindowIdentity {
  binding?: WindowBinding;
  private epoch = 0;
  private activation = 0;
  constructor(readonly windowInstanceId: string, private native: NativeApi, private focused: () => boolean, private codeExecutable: string) {}
  changed(): void { this.epoch++; }
  async observe(settleMs = 400): Promise<boolean> {
    const epoch = ++this.epoch;
    if (!this.focused()) return false;
    // VS Code can publish focused=true before Windows changes its foreground HWND.
    // Settle that event first, then verify one stable native handle; never activate here.
    await new Promise(resolve => setTimeout(resolve, settleMs));
    if (epoch !== this.epoch || !this.focused()) return false;
    const hwnd = this.native.foreground(); const before = this.native.inspect(hwnd);
    if (!before || !this.isCode(before)) return false;
    await new Promise(resolve => setTimeout(resolve, 150));
    if (epoch !== this.epoch || !this.focused() || this.native.foreground() !== hwnd) return false;
    const after = this.native.inspect(hwnd);
    if (!after || after.pid !== before.pid || !this.isCode(after)) return false;
    this.binding = { ...after, windowInstanceId: this.windowInstanceId, verifiedAt: new Date().toISOString(), method: 'focused-observation' };
    return true;
  }
  valid(): WindowBinding | undefined {
    const binding = this.binding;
    if (!binding) return;
    const current = this.native.inspect(binding.hwnd);
    if (!current || current.pid !== binding.pid || !this.isCode(current)) { this.binding = undefined; return; }
    return binding;
  }
  activate(): boolean {
    // Revalidate HWND, PID and executable immediately before changing focus.
    const binding = this.valid();
    return !!binding && this.native.activate(binding.hwnd);
  }
  async activateWithRetry(stillAllowed: () => boolean = () => true): Promise<boolean> {
    const activation = ++this.activation;
    const target = this.valid(); if (!target) return false;
    const input = this.native.lastInput();
    // A toast can still own the foreground while its click callback is draining.
    // Retry briefly after it closes, revalidating both ownership and the HWND.
    for (const delay of [0, 100, 250, 500]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (activation !== this.activation || !stillAllowed()) return false;
      const binding = this.valid();
      if (!binding || binding.hwnd !== target.hwnd || binding.pid !== target.pid) return false;
      if (this.native.foreground() === target.hwnd) return true;
      // Do not steal focus back after the user has moved on to another input.
      if (delay && (input === undefined || this.native.lastInput() !== input)) return false;
      this.native.activate(target.hwnd);
      if (this.native.foreground() === target.hwnd) return true;
    }
    return false;
  }
  cancelActivation(): void { this.activation++; }
  dispose(): void { this.epoch++; this.cancelActivation(); this.binding = undefined; }
  private isCode(window: NativeWindow): boolean { return resolve(window.executable).toLowerCase() === resolve(this.codeExecutable).toLowerCase(); }
}

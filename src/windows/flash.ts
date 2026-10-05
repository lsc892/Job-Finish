import { NativeApi, WindowBinding } from './native';
export interface FlashClock { now(): number; every(fn: () => void, ms: number): unknown; clear(timer: unknown): void }
const clock: FlashClock = { now: Date.now, every: (fn, ms) => setInterval(fn, ms), clear: timer => clearInterval(timer as NodeJS.Timeout) };
export class FlashController {
  private active?: { binding: WindowBinding; notificationId: string; timer: unknown };
  constructor(private native: NativeApi, private focused: () => boolean, private time: FlashClock = clock) {}
  start(binding: WindowBinding, notificationId: string, mode: 'manual' | 'system', timeoutMs: number): void {
    this.stop(); if (!this.valid(binding) || this.focused() || this.native.foreground() === binding.hwnd) return;
    const deadline = timeoutMs === 0 ? Infinity : this.time.now() + timeoutMs;
    if (mode === 'manual') this.native.flash(binding.hwnd, true); else this.native.flashEx(binding.hwnd, 2 | 12);
    const timer = this.time.every(() => {
      if (!this.valid(binding) || this.focused() || this.native.foreground() === binding.hwnd || this.time.now() >= deadline) this.stop();
      else if (mode === 'manual') this.native.flash(binding.hwnd, true);
    }, 500);
    this.active = { binding, notificationId, timer };
  }
  stop(notificationId?: string): void {
    const active = this.active;
    if (!active || (notificationId && notificationId !== active.notificationId)) return;
    this.active = undefined; this.time.clear(active.timer);
    if (this.valid(active.binding)) { this.native.flash(active.binding.hwnd, false); this.native.flashEx(active.binding.hwnd, 0); }
  }
  get activeNotificationId(): string | undefined { return this.active?.notificationId; }
  private valid(binding: WindowBinding): boolean {
    const current = this.native.inspect(binding.hwnd);
    return !!current && current.pid === binding.pid && current.executable === binding.executable;
  }
  dispose(): void { this.stop(); }
}

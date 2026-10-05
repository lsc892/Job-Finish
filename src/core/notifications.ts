import { LIMITS, Signal, toastText } from './model';
export interface NotificationPorts {
  focused(): boolean; owns(signal: Signal): boolean;
  stopFlash(id?: string): void;
  flash(signal: Signal): void;
  toast(signal: Signal, message: string, click: () => void, allowed: () => boolean): Promise<void>;
}
export class Notifications {
  readonly results: Signal[] = [];
  constructor(private ports: NotificationPorts) {}
  async deliver(signal: Signal): Promise<void> {
    if (!this.ports.owns(signal)) return;
    this.results.push(signal); if (this.results.length > LIMITS.results) this.results.shift();
    if (this.ports.focused()) { this.ports.stopFlash(); return; }
    this.ports.flash(signal);
    await this.ports.toast(signal, toastText(signal.text || signal.detail || signal.status),
      () => this.ports.stopFlash(signal.notificationId), () => !this.ports.focused() && this.ports.owns(signal));
  }
}

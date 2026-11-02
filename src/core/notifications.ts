// 소유권·포커스에 따라 최근 결과 저장과 토스트·깜박임 전달을 결정한다.
import { LIMITS, sessionTitleText, Signal, toastText } from './model';
export function notificationTitle(signal: Signal): string {
  return [signal.provider, signal.status, sessionTitleText(signal.sessionTitle)].filter(Boolean).join(' · ');
}
export interface NotificationPorts {
  enabled?(): boolean;
  focused(): boolean; owns(signal: Signal): boolean;
  stopFlash(id?: string): void;
  flash(signal: Signal): void;
  activate(signal: Signal): void;
  toast(signal: Signal, message: string, click: () => void, allowed: () => boolean): Promise<void>;
}
/** 소유한 실행 결과를 보관하고 포커스·활성화 설정에 맞춰 알림을 전달한다. */
export class Notifications {
  readonly results: Signal[] = [];
  constructor(private ports: NotificationPorts) {}
  // 최근 결과 20개를 보관하고 알림이 켜진 비활성 창에 토스트·깜박임을 전달한다.
  async deliver(signal: Signal): Promise<void> {
    if (!this.ports.owns(signal)) return;
    this.results.push(signal); if (this.results.length > LIMITS.results) this.results.shift();
    if (this.ports.enabled?.() === false || this.ports.focused()) { this.ports.stopFlash(); return; }
    this.ports.flash(signal);
    await this.ports.toast(signal, toastText(signal.text || signal.detail || signal.status),
      () => {
        this.ports.stopFlash(signal.notificationId);
        if (this.ports.enabled?.() !== false && this.ports.owns(signal)) this.ports.activate(signal);
      },
      () => this.ports.enabled?.() !== false && !this.ports.focused() && this.ports.owns(signal));
  }
}

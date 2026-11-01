// 소유한 실행 신호를 최근 결과에 저장하고 창 상태에 따라 깜박임과 토스트를 전달한다.
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
  async deliver(signal: Signal): Promise<void> {
    if (!this.ports.owns(signal)) return;
    this.results.push(signal); if (this.results.length > LIMITS.results) this.results.shift();
    if (this.ports.enabled?.() === false || this.ports.focused()) { this.ports.stopFlash(); return; }
    this.ports.flash(signal);
    await this.ports.toast(signal, toastText(signal.text || signal.detail || signal.status),
      () => {
        this.ports.stopFlash(signal.notificationId);
        if (this.ports.enabled?.() !== false && this.ports.owns(signal)) this.ports.activate(signal);
      }, () => this.ports.enabled?.() !== false && !this.ports.focused() && this.ports.owns(signal));
  }
}

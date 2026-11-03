// 소유권·포커스에 따라 최근 결과 저장과 토스트·깜박임 전달을 결정한다.
import { isTerminal, LIMITS, sessionTitleText, Signal, toastText } from './model';

const QUESTION_COMPLETION_MERGE_MS = 5000;
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
  private readonly questions = new Map<string, { at: number; delivered: Promise<boolean> }>();
  constructor(private ports: NotificationPorts, private readonly now: () => number = () => performance.now()) {}
  // 최근 결과 20개를 보관하고 알림이 켜진 비활성 창에 토스트·깜박임을 전달한다.
  async deliver(signal: Signal): Promise<void> {
    if (!this.ports.owns(signal)) return;
    this.results.push(signal); if (this.results.length > LIMITS.results) this.results.shift();
    const key = JSON.stringify([signal.windowInstanceId, signal.provider, signal.runtimeId, signal.connectionId, signal.sessionId, signal.turnId]);
    const question = this.questions.get(key);
    if (isTerminal(signal.status)) this.questions.delete(key);
    if (this.ports.enabled?.() === false || this.ports.focused()) { this.questions.delete(key); this.ports.stopFlash(); return; }
    // 질문 직후의 정상 완료는 결과만 보관한다. 전송 중이면 성공을 확인하고 실패 시 완료를 대신 알린다.
    if (signal.status === 'completed' && question && this.now() - question.at <= QUESTION_COMPLETION_MERGE_MS) {
      const delivered = await question.delivered;
      if (!this.ports.owns(signal)) return;
      if (this.ports.enabled?.() === false || this.ports.focused()) { this.ports.stopFlash(); return; }
      if (delivered) return;
    }
    this.ports.flash(signal);
    let allowed = true;
    const delivery = this.ports.toast(signal, toastText(signal.text || signal.detail || signal.status),
      () => {
        this.ports.stopFlash(signal.notificationId);
        if (this.ports.enabled?.() !== false && this.ports.owns(signal)) this.ports.activate(signal);
      },
      () => allowed = this.ports.enabled?.() !== false && !this.ports.focused() && this.ports.owns(signal));
    if (signal.kind === 'asyncQuestion' && signal.status === 'waitingForInput') {
      this.questions.set(key, { at: this.now(), delivered: delivery.then(() => allowed, () => false) });
      while (this.questions.size > LIMITS.dedup) this.questions.delete(this.questions.keys().next().value!);
    }
    await delivery;
  }
}

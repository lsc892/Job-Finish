// 소유권·포커스에 따라 최근 결과 저장과 토스트·깜박임 전달을 결정한다.
import { isTerminal, LIMITS, sessionTitleText, Signal } from './model';

const QUESTION_COMPLETION_MERGE_MS = 5000;
export function notificationTitle(signal: Signal): string {
  return [signal.provider, signal.status, sessionTitleText(signal.sessionTitle)].filter(Boolean).join(' · ');
}
export interface NotificationPorts {
  trace?(event: string, fields: Record<string, unknown>): void;
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
    if (!this.ports.owns(signal)) { this.trace(signal, 'notification.skipped', { reason: 'not-owner', stage: 'received' }); return; }
    this.results.push(signal); if (this.results.length > LIMITS.results) this.results.shift();
    const key = JSON.stringify([signal.windowInstanceId, signal.provider, signal.runtimeId, signal.connectionId, signal.sessionId, signal.turnId]);
    const question = this.questions.get(key);
    if (isTerminal(signal.status)) this.questions.delete(key);
    const reason = this.suppressionReason(signal);
    if (reason) {
      this.trace(signal, 'notification.skipped', { reason, stage: 'received' });
      this.questions.delete(key); this.ports.stopFlash(); return;
    }
    // 질문 직후의 정상 완료는 결과만 보관한다. 전송 중이면 성공을 확인하고 실패 시 완료를 대신 알린다.
    if (signal.status === 'completed' && question && this.now() - question.at <= QUESTION_COMPLETION_MERGE_MS) {
      this.trace(signal, 'notification.awaitingQuestion');
      const delivered = await question.delivered;
      if (!this.ports.owns(signal)) { this.trace(signal, 'notification.skipped', { reason: 'not-owner', stage: 'after-question' }); return; }
      const reason = this.suppressionReason(signal);
      if (reason) { this.trace(signal, 'notification.skipped', { reason, stage: 'after-question' }); this.ports.stopFlash(); return; }
      if (delivered) { this.trace(signal, 'notification.skipped', { reason: 'recent-question', stage: 'after-question' }); return; }
      this.trace(signal, 'notification.questionFallback');
    }
    this.trace(signal, 'notification.dispatching');
    this.ports.flash(signal);
    let allowed = true;
    const delivery = this.ports.toast(signal, signal.text || signal.detail || signal.status,
      () => {
        this.ports.stopFlash(signal.notificationId);
        if (this.ports.enabled?.() !== false && this.ports.owns(signal)) this.ports.activate(signal);
      },
      () => {
        const reason = this.suppressionReason(signal);
        if (reason) this.trace(signal, 'notification.skipped', { reason, stage: 'delivery-policy' });
        return allowed = !reason;
      });
    if (signal.kind === 'asyncQuestion' && signal.status === 'waitingForInput') {
      this.questions.set(key, { at: this.now(), delivered: delivery.then(() => allowed, () => false) });
      while (this.questions.size > LIMITS.dedup) this.questions.delete(this.questions.keys().next().value!);
    }
    await delivery;
  }

  private suppressionReason(signal: Signal): string | undefined {
    if (this.ports.enabled?.() === false) return 'disabled';
    if (this.ports.focused()) return 'focused';
    if (!this.ports.owns(signal)) return 'not-owner';
  }

  private trace(signal: Signal, event: string, fields: Record<string, unknown> = {}): void {
    this.ports.trace?.(event, { windowInstanceId: signal.windowInstanceId, notificationId: signal.notificationId,
      provider: signal.provider, runtimeId: signal.runtimeId, connectionId: signal.connectionId,
      sessionId: signal.sessionId, turnId: signal.turnId, status: signal.status, ...fields });
  }
}

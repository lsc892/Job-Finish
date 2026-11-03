// 관찰 세션 테스트용 바인딩·진단·알림 수집 도우미.
import { Diagnostics, SessionBinding, Signal } from '../src/core/model';
import { Session } from '../src/core/session';
export const binding = (overrides: Partial<SessionBinding> = {}): SessionBinding => ({ windowInstanceId: 'window-A', provider: 'codex', runtimeId: 'runtime', connectionId: 'connection-1', sessionId: 'thread-A', ...overrides });
export function fixture(overrides: Partial<SessionBinding> = {}) {
  const signals: Signal[] = []; const diagnostics = new Diagnostics();
  const session = new Session(binding(overrides), signal => signals.push(signal), diagnostics);
  return { session, signals, diagnostics };
}

import { Diagnostics, SessionBinding, Signal } from '../src/core/model';
import { Session } from '../src/core/session';
export const binding = (overrides: Partial<SessionBinding> = {}): SessionBinding => ({ windowInstanceId: 'window-A', provider: 'codex', runtimeId: 'runtime', connectionId: 'connection-1', sessionId: 'thread-A', source: 'ownedExecution', ...overrides });
export function fixture(overrides: Partial<SessionBinding> = {}) {
  const signals: Signal[] = []; const diagnostics = new Diagnostics(); let owns = true;
  const session = new Session(binding(overrides), () => owns, () => {}, signal => signals.push(signal), diagnostics);
  return { session, signals, diagnostics, revoke: () => { owns = false; } };
}

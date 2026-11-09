// 관찰 연결의 제공자 이벤트 처리기와 세션 수명을 연결한다.
import { randomUUID } from 'node:crypto';
import { Diagnostics, Provider, Signal } from '../core/model';
import { Session } from '../core/session';
import type { AgentEvents } from './agent-provider';
import { agentProviders } from './providers';
import { identifier, record } from './message';

const MAX_OBSERVED_SESSIONS = 32;

/** 관찰 연결의 세션 수명을 관리하고 메시지 해석을 제공자 처리기에 위임한다. */
export class AgentEventRouter {
  readonly connectionId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private readonly events: AgentEvents;
  private disposed = false;
  private incomingMessages = 0;
  private outgoingMessages = 0;
  private lastIncomingEvent?: string;
  constructor(readonly provider: Provider, private windowInstanceId: string, private runtimeId: string,
    private emit: (signal: Signal) => void, private diagnostics: Diagnostics) {
    this.events = agentProviders[provider].createEvents({ connectionId: this.connectionId,
      trace: (event, fields) => { diagnostic: this.diagnostics.trace(event, { ...fields, windowInstanceId: this.windowInstanceId,
        provider: this.provider, runtimeId: this.runtimeId, connectionId: this.connectionId }); },
      session: id => this.session(id), existingSession: id => this.sessions.get(id) });
  }
  outgoing(value: unknown): void {
    const message = record(value); if (!message || this.disposed) return;
    this.outgoingMessages++;
    this.events.outgoing(message);
  }
  incoming(value: unknown): void {
    const message = record(value); if (!message || this.disposed) return;
    this.incomingMessages++;
    this.lastIncomingEvent = typeof message.method === 'string' ? message.method.slice(0, 128)
      : typeof message.type === 'string' ? message.type.slice(0, 128) : 'rpc-response';
    diagnostic: if (message.method === 'turn/started' || message.method === 'turn/completed' || message.method === 'error' || message.type === 'result') {
      const params = record(message.params); const turn = record(params?.turn);
      this.diagnostics.trace('runtime.lifecycle', { windowInstanceId: this.windowInstanceId, provider: this.provider,
        runtimeId: this.runtimeId, connectionId: this.connectionId,
        method: typeof message.method === 'string' ? message.method.slice(0, 128) : undefined,
        type: typeof message.type === 'string' ? message.type.slice(0, 128) : undefined,
        sessionId: identifier(params?.threadId ?? message.session_id), turnId: identifier(turn?.id ?? params?.turnId),
        status: typeof turn?.status === 'string' ? turn.status.slice(0, 128) : undefined,
        subtype: typeof message.subtype === 'string' ? message.subtype.slice(0, 128) : undefined,
        isError: typeof message.is_error === 'boolean' ? message.is_error : undefined });
    }
    this.events.incoming(message);
  }
  private session(id: string): Session | undefined {
    if (this.disposed) return;
    const existing = this.sessions.get(id);
    if (existing) return existing;
    // 상한에 도달하면 입력 대기와 실행이 모두 없는 첫 세션만 제거한다.
    if (this.sessions.size >= MAX_OBSERVED_SESSIONS) {
      const idle = [...this.sessions].find(([, session]) => session.turns.size === 0 && session.requests.size === 0);
      if (!idle) throw new Error('Observed session limit exceeded');
      this.sessions.delete(idle[0]);
    }
    const session = new Session({ windowInstanceId: this.windowInstanceId, provider: this.provider, runtimeId: this.runtimeId,
      connectionId: this.connectionId, sessionId: id }, this.emit, this.diagnostics);
    this.sessions.set(id, session);
    return session;
  }
  snapshot() { return { provider: this.provider, connectionId: this.connectionId, sessions: this.sessions.size,
    incomingMessages: this.incomingMessages, outgoingMessages: this.outgoingMessages, lastIncomingEvent: this.lastIncomingEvent,
    activeTurns: [...this.sessions.values()].reduce((count, s) => count + s.turns.size, 0) }; }
  dispose(): void { this.disposed = true; this.sessions.clear(); this.events.dispose(); }
}

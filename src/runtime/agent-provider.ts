import type { Provider } from '../core/model';
import type { Session } from '../core/session';

export interface AgentEvents {
  incoming(message: Record<string, unknown>): void;
  outgoing(message: Record<string, unknown>): void;
  dispose(): void;
}

export interface EventContext {
  readonly connectionId: string;
  trace(event: string, fields: Record<string, unknown>): void;
  session(id: string): Session | undefined;
  existingSession(id: string): Session | undefined;
}

/** 지원하는 두 확장의 프로세스 식별과 연결별 이벤트 해석 계약. */
export interface AgentProvider {
  readonly id: Provider;
  readonly extensionId: string;
  matchesProcess(args: readonly string[]): boolean;
  createEvents(context: EventContext): AgentEvents;
}

// 세션 조회·저장 형식과 애플리케이션에서 주입하는 서비스 계약을 정의한다.
import type { Session } from '../../core/session';
import type { Diagnostics, Provider, SessionBinding, Signal } from '../../core/model';
import type { Lease } from '../../core/ownership';
import type { AgentExecution, AgentProvider } from '../../runtime/agent-provider';

export interface ApplicationSession {
  provider: Provider;
  cwd: string;
  session: Session;
  execution: AgentExecution;
}

export interface SavedSession {
  provider: Provider;
  cwd: string;
  sessionId: string;
}

export type SessionLease = Pick<Lease, 'valid' | 'load' | 'save' | 'release'>;

export interface ApplicationSessionPorts {
  windowInstanceId: string;
  diagnostics: Diagnostics;
  trusted(): boolean;
  config<T>(key: string, fallback: T): T;
  provider(id: Provider): Pick<AgentProvider, 'runtimeId' | 'createExecution'>;
  claim(binding: SessionBinding): SessionLease;
  saved(): SavedSession[];
  save(sessions: SavedSession[]): PromiseLike<void>;
  signal(signal: Signal): void;
  changed(): void;
  released(): void;
}

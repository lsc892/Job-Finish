// 연결 하나의 실행·Session·소유권 임대를 생성하고 실패·해제 시 정리한다.
import { Session } from '../../core/session';
import type { Provider, SessionBinding } from '../../core/model';
import type { AgentExecution, AgentProvider } from '../../runtime/agent-provider';
import type { ApplicationSession, ApplicationSessionPorts, SessionLease } from './types';

export interface OwnedSession extends ApplicationSession {
  resources: SessionResources;
}

interface SessionRegistry {
  active(): boolean;
  register(entry: OwnedSession): void;
  remove(resources: SessionResources): void;
}

type SessionResourcePorts = Pick<ApplicationSessionPorts,
  'windowInstanceId' | 'diagnostics' | 'claim' | 'config' | 'signal' | 'changed' | 'released'>;

/** 연결 진행 상태와 실행·lease를 소유하며 등록 변경은 콜백으로 알린다. */
export class SessionResources {
  entry?: OwnedSession;
  private execution?: AgentExecution;
  private lease?: SessionLease;
  private cancelled = false;

  constructor(
    private readonly provider: Provider,
    private readonly cwd: string,
    private readonly ports: SessionResourcePorts,
    private readonly registry: SessionRegistry
  ) {}

  owns(): boolean {
    return this.lease?.valid() === true;
  }

  assertActive(): void {
    if (!this.registry.active() || this.cancelled) throw new Error('Extension deactivated');
  }

  createExecution(implementation: Pick<AgentProvider, 'runtimeId' | 'createExecution'>, sessionId?: string): AgentExecution {
    const execution = implementation.createExecution({
      cwd: this.cwd,
      sessionId,
      diagnostics: this.ports.diagnostics,
      config: (key, fallback) => this.ports.config(key, fallback),
      createSession: (id, connectionId) => this.createSession(implementation, id, connectionId),
    });
    this.execution = execution;
    return execution;
  }

  register(session: Session, execution: AgentExecution): OwnedSession {
    if (this.entry?.session === session && this.entry.execution === execution) return this.entry;
    const entry = { provider: this.provider, cwd: this.cwd, session, execution, resources: this };
    this.entry = entry;
    this.registry.register(entry);
    return entry;
  }

  detach(): void {
    this.cancelled = true;
    const execution = this.execution;
    const lease = this.lease;
    this.execution = undefined;
    this.lease = undefined;

    try {
      execution?.dispose();
    } finally {
      // 명시적 해제는 정리를 끝낸 뒤 오류를 호출자에게 전파한다.
      try {
        lease?.release();
      } finally {
        this.registry.remove(this);
        this.ports.released();
      }
    }
  }

  cleanupOpening(): void {
    // 실패한 open의 최초 오류를 보존하면서 나머지 자원을 계속 정리한다.
    this.cancelled = true;
    const execution = this.execution;
    this.execution = undefined;
    try {
      execution?.dispose();
    } catch (error) {
      this.ports.diagnostics.add(error);
    }
    this.registry.remove(this);

    const lease = this.lease;
    this.lease = undefined;
    try {
      lease?.release();
    } catch (error) {
      this.ports.diagnostics.add(error);
    }
  }

  private createSession(implementation: Pick<AgentProvider, 'runtimeId'>, sessionId: string, connectionId: string): Session {
    this.assertActive();
    const binding: SessionBinding = {
      windowInstanceId: this.ports.windowInstanceId,
      provider: this.provider,
      runtimeId: implementation.runtimeId(),
      connectionId,
      sessionId,
      source: 'ownedExecution',
    };
    const lease = this.ports.claim(binding);
    this.lease = lease;
    const session = new Session(
      binding,
      () => lease.valid(),
      state => lease.save(state),
      signal => this.ports.signal(signal),
      this.ports.diagnostics,
      lease.load(),
      () => this.ports.changed()
    );
    // 비동기 open의 초기 결과도 소유권을 확인할 수 있도록 즉시 등록한다.
    if (this.execution) this.register(session, this.execution);
    return session;
  }
}

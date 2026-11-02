// 창의 세션 목록·연결 상한·저장 기록과 개별 자원의 수명을 조율한다.
import type { Provider } from '../../core/model';
import { SessionResources } from './resources';
import type { OwnedSession } from './resources';
import type { ApplicationSession, ApplicationSessionPorts, SavedSession } from './types';

export type { ApplicationSession, ApplicationSessionPorts, SavedSession, SessionLease } from './types';

const SAVED_SESSION_LIMIT = 32;

/** 생성 중인 연결을 포함해 세션 목록·저장 기록과 전체 종료를 관리한다. */
export class ApplicationSessions {
  private readonly entries = new Map<string, OwnedSession>();
  private readonly opening = new Set<SessionResources>();
  private disposed = false;

  constructor(private readonly ports: ApplicationSessionPorts) {}

  get(sessionId: string): ApplicationSession | undefined {
    return this.entries.get(sessionId);
  }

  values(): IterableIterator<ApplicationSession> {
    return this.entries.values();
  }

  saved(): SavedSession[] {
    return this.ports.saved();
  }

  has(provider: Provider, sessionId: string): boolean {
    return this.entries.get(sessionId)?.provider === provider;
  }

  owns(sessionId: string): boolean {
    return this.entries.get(sessionId)?.resources.owns() === true;
  }

  get pendingRequests(): number {
    return [...this.entries.values()].reduce((count, entry) => count + entry.session.requests.size, 0);
  }

  snapshot() {
    return [...this.entries.values()].map(entry => ({
      binding: entry.session.binding,
      state: entry.session.checkpoint(),
      pending: entry.session.requests.size
    }));
  }

  async open(provider: Provider, cwd: string, sessionId?: string): Promise<ApplicationSession> {
    if (this.disposed) throw new Error('Extension deactivated');
    if (!this.ports.trusted()) throw new Error('Trust the workspace before running an agent');
    if (this.entries.size + this.opening.size >= this.ports.config('maxSessions', 8)
      || this.entries.size + this.opening.size >= this.ports.config('maxConnections', 4)) {
      throw new Error('Session/connection limit reached. Release an existing session first.');
    }
    if (sessionId && this.entries.has(sessionId)) throw new Error('Session is already connected in this window');
    const implementation = this.ports.provider(provider);
    const resources = new SessionResources(provider, cwd, this.ports, {
      active: () => !this.disposed,
      register: entry => this.entries.set(entry.session.binding.sessionId, entry),
      remove: resources => this.removeEntry(resources),
    });
    this.opening.add(resources);

    try {
      const execution = resources.createExecution(implementation, sessionId);
      resources.assertActive();
      if (execution.open) await execution.open(sessionId);
      resources.assertActive();

      const session = execution.session;
      if (!session) throw new Error(`Agent provider ${provider} did not create a session`);
      const entry = resources.register(session, execution);
      // 같은 세션의 저장 기록을 최신 위치로 옮기고 최근 32개만 보관한다.
      const saved = this.saved();
      const record: SavedSession = { provider, cwd, sessionId: session.binding.sessionId };
      const otherSessions = saved.filter(item => item.sessionId !== record.sessionId);
      await this.ports.save([...otherSessions, record].slice(-SAVED_SESSION_LIMIT));
      resources.assertActive();
      this.ports.changed();
      return entry;
    } catch (error) {
      resources.cleanupOpening();
      throw error;
    } finally {
      this.opening.delete(resources);
    }
  }

  detach(entry: ApplicationSession): void {
    const owned = this.entries.get(entry.session.binding.sessionId);
    if (owned !== entry) return;
    owned.resources.detach();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      try {
        this.detach(entry);
      } catch (error) {
        this.ports.diagnostics.add(error);
      }
    }
    for (const resources of this.opening) resources.cleanupOpening();
    this.entries.clear();
  }

  private removeEntry(resources: SessionResources): void {
    const id = resources.entry?.session.binding.sessionId;
    if (id && this.entries.get(id)?.resources === resources) this.entries.delete(id);
  }
}

import { Session } from '../core/session';
import type { Diagnostics, Provider, SessionBinding, Signal } from '../core/model';
import type { Lease } from '../core/ownership';
import type { AgentExecution, AgentProvider } from '../runtime/agent-provider';

export interface ApplicationSession { provider: Provider; cwd: string; session: Session; execution: AgentExecution }
export interface SavedSession { provider: Provider; cwd: string; sessionId: string }
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
interface SessionResources {
  provider: Provider;
  cwd: string;
  execution?: AgentExecution;
  lease?: SessionLease;
  entry?: OwnedSession;
  cancelled: boolean;
}
interface OwnedSession extends ApplicationSession { resources: SessionResources }
const SAVED_SESSION_LIMIT = 32;

/** Owns executions and leases from factory invocation through release, including pending opens. */
export class ApplicationSessions {
  private readonly entries = new Map<string, OwnedSession>();
  private readonly opening = new Set<SessionResources>();
  private disposed = false;
  constructor(private readonly ports: ApplicationSessionPorts) {}

  get(sessionId: string): ApplicationSession | undefined { return this.entries.get(sessionId); }
  values(): IterableIterator<ApplicationSession> { return this.entries.values(); }
  saved(): SavedSession[] { return this.ports.saved(); }
  has(provider: Provider, sessionId: string): boolean { return this.entries.get(sessionId)?.provider === provider; }
  owns(sessionId: string): boolean { return this.entries.get(sessionId)?.resources.lease?.valid() === true; }
  get pendingRequests(): number { return [...this.entries.values()].reduce((count, entry) => count + entry.session.requests.size, 0); }
  snapshot() {
    return [...this.entries.values()].map(entry => ({ binding: entry.session.binding, state: entry.session.checkpoint(), pending: entry.session.requests.size }));
  }

  async open(provider: Provider, cwd: string, sessionId?: string): Promise<ApplicationSession> {
    this.assertActive();
    if (!this.ports.trusted()) throw new Error('Trust the workspace before running an agent');
    if (this.entries.size + this.opening.size >= this.ports.config('maxSessions', 8)
      || this.entries.size + this.opening.size >= this.ports.config('maxConnections', 4)) {
      throw new Error('Session/connection limit reached. Release an existing session first.');
    }
    if (sessionId && this.entries.has(sessionId)) throw new Error('Session is already connected in this window');
    const implementation = this.ports.provider(provider);
    const resources: SessionResources = { provider, cwd, cancelled: false };
    this.opening.add(resources);
    try {
      const execution = implementation.createExecution({
        cwd,
        sessionId,
        diagnostics: this.ports.diagnostics,
        config: (key, fallback) => this.ports.config(key, fallback),
        createSession: (id, connectionId) => this.createSession(resources, implementation, id, connectionId),
      });
      resources.execution = execution;
      this.assertActive(resources);
      if (execution.open) await execution.open(sessionId);
      this.assertActive(resources);
      const session = execution.session;
      if (!session) throw new Error(`Agent provider ${provider} did not create a session`);
      const entry = this.register(resources, session, execution);
      const saved = this.saved();
      const record = { provider, cwd, sessionId: session.binding.sessionId };
      await this.ports.save([...saved.filter(item => item.sessionId !== record.sessionId), record].slice(-SAVED_SESSION_LIMIT));
      this.assertActive(resources);
      this.ports.changed();
      return entry;
    } catch (error) {
      this.cleanupOpening(resources);
      throw error;
    } finally {
      this.opening.delete(resources);
    }
  }
  private createSession(resources: SessionResources, implementation: Pick<AgentProvider, 'runtimeId'>, sessionId: string, connectionId: string): Session {
    this.assertActive(resources);
    const binding: SessionBinding = {
      windowInstanceId: this.ports.windowInstanceId,
      provider: resources.provider,
      runtimeId: implementation.runtimeId(),
      connectionId,
      sessionId,
      source: 'ownedExecution',
    };
    const lease = this.ports.claim(binding);
    resources.lease = lease;
    const session = new Session(binding, () => lease.valid(), state => lease.save(state),
      signal => this.ports.signal(signal), this.ports.diagnostics, lease.load(), () => this.ports.changed());
    // An async runtime may emit a reconciled result before its open call returns.
    if (resources.execution) this.register(resources, session, resources.execution);
    return session;
  }
  private register(resources: SessionResources, session: Session, execution: AgentExecution): OwnedSession {
    if (resources.entry?.session === session && resources.entry.execution === execution) return resources.entry;
    const entry = { provider: resources.provider, cwd: resources.cwd, session, execution, resources };
    resources.entry = entry;
    this.entries.set(session.binding.sessionId, entry);
    return entry;
  }
  private assertActive(resources?: SessionResources): void {
    if (this.disposed || resources?.cancelled) throw new Error('Extension deactivated');
  }
  private removeEntry(resources: SessionResources): void {
    const id = resources.entry?.session.binding.sessionId;
    if (id && this.entries.get(id)?.resources === resources) this.entries.delete(id);
  }
  private cleanupOpening(resources: SessionResources): void {
    resources.cancelled = true;
    const execution = resources.execution;
    resources.execution = undefined;
    try { execution?.dispose(); }
    catch (error) { this.ports.diagnostics.add(error); }
    this.removeEntry(resources);
    const lease = resources.lease;
    resources.lease = undefined;
    try { lease?.release(); }
    catch (error) { this.ports.diagnostics.add(error); }
  }

  detach(entry: ApplicationSession): void {
    const owned = this.entries.get(entry.session.binding.sessionId);
    if (owned !== entry) return;
    const resources = owned.resources;
    resources.cancelled = true;
    const execution = resources.execution;
    const lease = resources.lease;
    resources.execution = undefined;
    resources.lease = undefined;
    try { execution?.dispose(); }
    finally {
      try { lease?.release(); }
      finally { this.removeEntry(resources); this.ports.released(); }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      try { this.detach(entry); }
      catch (error) { this.ports.diagnostics.add(error); }
    }
    for (const resources of this.opening) this.cleanupOpening(resources);
    this.entries.clear();
  }
}

import { randomUUID } from 'node:crypto';
import { Diagnostics, Provider, Signal } from '../core/model';
import { Session } from '../core/session';
import type { AgentEvents, AgentProviderRegistry } from './agent-provider';
import { agentProviders } from './providers';
import { record } from './message';

const MAX_OBSERVED_SESSIONS = 32;

/** Owns connection/session lifetime; provider handlers interpret protocol messages. */
export class AgentEventRouter {
  readonly connectionId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private readonly events: AgentEvents;
  private disposed = false;
  constructor(readonly provider: Provider, private windowInstanceId: string, private runtimeId: string,
    private emit: (signal: Signal) => void, private diagnostics: Diagnostics,
    private isOwned: (provider: Provider, sessionId: string) => boolean = () => false,
    providers: AgentProviderRegistry = agentProviders) {
    this.events = providers.get(provider).createEvents({ connectionId: this.connectionId,
      session: id => this.session(id), existingSession: id => this.sessions.get(id) });
  }
  outgoing(value: unknown): void {
    const message = record(value); if (!message || this.disposed) return;
    this.events.outgoing(message);
  }
  incoming(value: unknown): void {
    const message = record(value); if (!message || this.disposed) return;
    this.events.incoming(message);
  }
  private session(id: string): Session | undefined {
    if (this.disposed || this.isOwned(this.provider, id)) return;
    const existing = this.sessions.get(id);
    if (existing) return existing;
    this.makeRoomForSession();
    const session = new Session({ windowInstanceId: this.windowInstanceId, provider: this.provider, runtimeId: this.runtimeId,
      connectionId: this.connectionId, sessionId: id, source: 'verifiedIntegration' },
    () => !this.disposed && !this.isOwned(this.provider, id), () => {}, this.emit, this.diagnostics);
    this.sessions.set(id, session);
    return session;
  }
  private makeRoomForSession(): void {
    if (this.sessions.size < MAX_OBSERVED_SESSIONS) return;
    const idle = [...this.sessions].find(([, session]) => session.turns.size === 0 && session.requests.size === 0);
    if (!idle) throw new Error('Observed session limit exceeded');
    this.sessions.delete(idle[0]);
  }
  snapshot() { return { provider: this.provider, connectionId: this.connectionId, sessions: this.sessions.size,
    activeTurns: [...this.sessions.values()].reduce((count, s) => count + s.turns.size, 0) }; }
  dispose(): void { this.disposed = true; this.sessions.clear(); this.events.dispose(); }
}

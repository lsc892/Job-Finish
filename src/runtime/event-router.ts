import { randomUUID } from 'node:crypto';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { Diagnostics, LIMITS, Provider, Signal } from '../core/model';
import { Session } from '../core/session';
import { acceptClaudeResult } from './claude';
import { CodexAdapter } from './codex';
import type { RpcMessage } from './transport';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;

/** One router per actual stdio connection. It never sends requests or owns the agent process. */
export class AgentEventRouter {
  readonly connectionId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private readonly ignored = new Set<string>();
  private readonly pendingThreads = new Map<string, boolean>();
  private readonly claudeRequests: { id: string; supplied: boolean }[] = [];
  private readonly claudeResults = new Set<string>();
  private claudeSessionId?: string;
  private disposed = false;
  constructor(readonly provider: Provider, private windowInstanceId: string, private runtimeId: string,
    private emit: (signal: Signal) => void, private diagnostics: Diagnostics,
    private isOwned: (provider: Provider, sessionId: string) => boolean = () => false) {}

  outgoing(value: unknown): void {
    const message = record(value); if (!message || this.disposed) return;
    if (this.provider === 'codex') {
      if (message.method === 'thread/start' && message.id !== undefined) {
        const params = record(message.params);
        this.pendingThreads.set(JSON.stringify(message.id), params?.ephemeral === true);
        this.bound(this.pendingThreads);
      }
      return;
    }
    if (message.type === 'user') {
      // Only identifiers are retained; prompts and tool contents remain in the original transport.
      if (this.claudeRequests.length >= LIMITS.turns) throw new Error('Observed Claude input queue exceeds limit');
      const id = identifier(message.uuid);
      this.claudeRequests.push({ id: id ?? randomUUID(), supplied: !!id });
      const sessionId = identifier(message.session_id) ?? this.claudeSessionId;
      if (sessionId) this.session(sessionId)?.start(this.claudeRequests[0]!.id, this.connectionId);
    } else if (message.type === 'control_response' && this.claudeSessionId) {
      const response = record(message.response); const id = identifier(response?.request_id);
      if (id) this.sessions.get(this.claudeSessionId)?.resolve(id, this.connectionId);
    } else if (message.type === 'control_request') {
      const request = record(message.request);
      if (request?.subtype === 'interrupt' && this.claudeSessionId) {
        // Wait for the explicit control response, rather than treating an outgoing request as acknowledgement.
        const id = identifier(message.request_id);
        if (id) this.pendingThreads.set(id, true);
        this.bound(this.pendingThreads);
      }
    }
  }

  incoming(value: unknown): void {
    const message = record(value); if (!message || this.disposed) return;
    if (this.provider === 'codex') this.codex(message); else this.claude(message);
  }

  private codex(message: Record<string, unknown>): void {
    const params = record(message.params);
    const result = record(message.result);
    const thread = record(params?.thread ?? result?.thread);
    if (thread && identifier(thread.id)) {
      const pendingKey = JSON.stringify(message.id);
      if (thread.ephemeral === true || thread.parentThreadId || record(thread.source)?.subAgent || this.pendingThreads.get(pendingKey)) {
        this.ignored.add(thread.id as string); this.bound(this.ignored);
      }
      this.pendingThreads.delete(pendingKey);
    }
    // History RPC responses never enter the live notification path.
    if (typeof message.method !== 'string' || !params) return;
    const id = identifier(params.threadId); if (!id || this.ignored.has(id)) return;
    const relevant = ['turn/started', 'turn/completed', 'item/completed', 'serverRequest/resolved', 'error',
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!relevant.includes(message.method)) return;
    const session = this.session(id); if (!session) return;
    const turn = record(params.turn);
    const turnId = identifier(turn?.id ?? params.turnId);
    // A live completion or input request also identifies a turn already running when observation began.
    // Unlike an RPC history response, this comes directly from this window's active runtime connection.
    if (turnId && message.method !== 'error') session.start(turnId, this.connectionId);
    new CodexAdapter(session).handle(message as RpcMessage, this.connectionId, true);
  }

  private claude(message: Record<string, unknown>): void {
    const sessionId = identifier(message.session_id);
    if (sessionId) this.claudeSessionId = sessionId;
    if (message.type === 'system' && message.subtype === 'init' && sessionId && this.claudeRequests.length) {
      this.session(sessionId)?.start(this.claudeRequests[0]!.id, this.connectionId);
    } else if (message.type === 'result' && sessionId) {
      if (!identifier(message.uuid) || typeof message.is_error !== 'boolean' || typeof message.subtype !== 'string') throw new Error('Malformed observed Claude result');
      if (message.subtype === 'success' ? typeof message.result !== 'string' : !Array.isArray(message.errors) || message.errors.some(e => typeof e !== 'string')) throw new Error('Malformed observed Claude result body');
      if (this.claudeResults.has(message.uuid as string)) return;
      const session = this.session(sessionId); if (!session) return;
      const userId = identifier(message.user_message_uuid);
      const queued = this.claudeRequests[0];
      if (userId && queued?.supplied && queued.id !== userId) return;
      const turnId = userId ?? queued?.id ?? message.uuid as string;
      const previousId = queued?.id ?? (session.turns.size === 1 ? session.turns.keys().next().value : undefined);
      if (previousId && previousId !== turnId) {
        // Some extension versions add the UUID after writing the user input. Transfer the observed state.
        const previous = session.turns.get(previousId);
        if (previous) {
          for (const request of [...session.requests.values()]) if (request.turnId === previousId) session.resolve(request.id, this.connectionId);
          session.turns.delete(previousId); session.start(turnId, this.connectionId); session.body(turnId, previous.text, this.connectionId);
        }
      }
      session.start(turnId, this.connectionId);
      acceptClaudeResult(session, turnId, message as unknown as SDKResultMessage, this.connectionId);
      this.claudeResults.add(message.uuid as string); this.bound(this.claudeResults);
      if (queued) this.claudeRequests.shift();
    } else if (message.type === 'control_request') {
      const request = record(message.request);
      const id = identifier(message.request_id);
      if (!id || request?.subtype !== 'can_use_tool' || !this.claudeSessionId) return;
      const session = this.session(this.claudeSessionId); if (!session) return;
      const turnId = this.claudeRequests[0]?.id ?? [...session.turns.keys()][0] ?? `input:${id}`;
      session.start(turnId, this.connectionId);
      const question = request.tool_name === 'AskUserQuestion';
      const input = record(request.input);
      const questions = Array.isArray(input?.questions) ? input.questions.map(q => record(q)?.question).filter(q => typeof q === 'string').join('\n') : '';
      session.waiting({ id, turnId, connectionId: this.connectionId, kind: question ? 'question' : 'approval',
        title: question ? questions || 'Claude needs an answer' : `Claude: ${String(request.tool_name ?? 'tool')} approval`, payload: null });
    } else if (message.type === 'control_cancel_request') {
      if (this.claudeSessionId && identifier(message.request_id)) this.sessions.get(this.claudeSessionId)?.resolve(message.request_id as string, this.connectionId);
    } else if (message.type === 'control_response') {
      const response = record(message.response); const id = identifier(response?.request_id);
      if (id && this.claudeSessionId) {
        const session = this.sessions.get(this.claudeSessionId);
        session?.resolve(id, this.connectionId);
        if (this.pendingThreads.delete(id) && response?.subtype === 'success') {
          const turn = this.claudeRequests.shift();
          if (turn) session?.finish(turn.id, 'cancelled', this.connectionId, 'Interrupt acknowledged by the existing Claude runtime');
        }
      }
    }
  }

  private session(id: string): Session | undefined {
    if (this.disposed || this.isOwned(this.provider, id)) return;
    let session = this.sessions.get(id);
    if (!session) {
      if (this.sessions.size >= 32) {
        const idle = [...this.sessions].find(([, s]) => s.turns.size === 0 && s.requests.size === 0);
        if (!idle) throw new Error('Observed session limit exceeded');
        this.sessions.delete(idle[0]);
      }
      session = new Session({ windowInstanceId: this.windowInstanceId, provider: this.provider, runtimeId: this.runtimeId,
        connectionId: this.connectionId, sessionId: id, source: 'verifiedIntegration' },
      () => !this.disposed && !this.isOwned(this.provider, id), () => {}, this.emit, this.diagnostics);
      this.sessions.set(id, session);
    }
    return session;
  }
  private bound(collection: Map<string, unknown> | Set<string>): void {
    while (collection.size > LIMITS.dedup) collection.delete(collection.keys().next().value!);
  }
  snapshot() { return { provider: this.provider, connectionId: this.connectionId, sessions: this.sessions.size,
    activeTurns: [...this.sessions.values()].reduce((count, s) => count + s.turns.size, 0) }; }
  dispose(): void { this.disposed = true; this.sessions.clear(); this.pendingThreads.clear(); this.ignored.clear(); this.claudeResults.clear(); this.claudeRequests.length = 0; }
}

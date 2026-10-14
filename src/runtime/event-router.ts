import { randomUUID } from 'node:crypto';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { Diagnostics, LIMITS, Provider, Signal, taskTitle } from '../core/model';
import { Session } from '../core/session';
import { inputQuestionText } from '../core/input';
import { acceptClaudeResult } from './claude';
import { CLAUDE_OAUTH_REFRESH_ERROR, claudeOAuthRefreshError } from './claude-errors';
import { CodexAdapter, observedCodexQuestion } from './codex';
import type { RpcMessage } from './transport';
import { inputTitle } from './titles';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;

/** One router per actual stdio connection. It never sends requests or owns the agent process. */
export class AgentEventRouter {
  readonly connectionId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private readonly ignored = new Set<string>();
  private readonly pendingThreads = new Map<string, boolean>();
  private readonly titles = new Map<string, string>();
  private readonly codexStartTitles = new Map<string, { threadId: string; title: string }>();
  private readonly codexTurnTitles = new Map<string, string>();
  private readonly codexInputEpisodes = new Map<string, { waiting: boolean; episode: number }>();
  private readonly claudeRequests: { id: string; supplied: boolean; title?: string }[] = [];
  private readonly claudeResults = new Set<string>();
  private readonly claudeErrorTurns = new Set<string>();
  private readonly claudeErrorMessages = new Set<string>();
  private readonly claudeInitializations = new Set<string>();
  private readonly claudeDialogs = new Set<string>();
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
      } else if (message.method === 'turn/start' && message.id !== undefined) {
        const params = record(message.params); const threadId = identifier(params?.threadId); const title = inputTitle(params?.input);
        if (threadId && title) {
          this.codexStartTitles.set(JSON.stringify(message.id), { threadId, title }); this.bound(this.codexStartTitles);
        }
      }
      if (!message.method && message.id !== undefined && ('result' in message || 'error' in message)) {
        const requestId = JSON.stringify(message.id);
        for (const session of this.sessions.values()) {
          const request = session.requests.get(requestId);
          if (!request) continue;
          session.resolve(requestId, this.connectionId);
          session.clearInputNotice(request.turnId, this.connectionId);
        }
      } else if (message.method === 'turn/steer' || message.method === 'turn/start') {
        const params = record(message.params);
        const session = typeof params?.threadId === 'string' ? this.sessions.get(params.threadId) : undefined;
        if (session) for (const turn of session.turns.values()) session.clearInputNotice(turn.id, this.connectionId);
      }
      return;
    }
    if (message.type === 'user') {
      // Retain a bounded display title; full prompts and tool contents remain in the transport.
      if (this.claudeRequests.length >= LIMITS.turns) throw new Error('Observed Claude input queue exceeds limit');
      const id = identifier(message.uuid);
      this.claudeRequests.push({ id: id ?? randomUUID(), supplied: !!id, title: inputTitle(record(message.message)?.content) });
      const sessionId = identifier(message.session_id) ?? this.claudeSessionId;
      if (sessionId) this.session(sessionId)?.start(this.claudeRequests[0]!.id, this.connectionId, this.claudeRequests[0]!.title);
    } else if (message.type === 'control_response' && this.claudeSessionId) {
      this.claudeResponse(record(message.response));
    } else if (message.type === 'control_request') {
      const request = record(message.request);
      if (request?.subtype === 'initialize') {
        const id = identifier(message.request_id);
        if (id) this.claudeInitializations.add(id);
        this.bound(this.claudeInitializations);
      }
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
      if (this.pendingThreads.get(pendingKey)) this.ignoreCodexThread(thread.id as string);
      this.pendingThreads.delete(pendingKey);
      this.codexThread(thread);
    }
    // Thread listings can be the only metadata observed for an already running child.
    if (Array.isArray(result?.data)) for (const entry of result.data) {
      const listed = record(entry);
      if (listed && ('parentThreadId' in listed || 'source' in listed && 'turns' in listed)) this.codexThread(listed);
    }
    // Learn child IDs before dispatch, even when the sender is itself an ignored child.
    const senderId = identifier(params?.threadId);
    if (senderId) {
      if (message.method === 'item/started' || message.method === 'item/completed') this.codexAgentItem(params?.item, senderId);
      this.codexAgentItems(record(params?.turn)?.items, senderId);
    }
    if (message.id !== undefined) {
      const requestKey = JSON.stringify(message.id); const pending = this.codexStartTitles.get(requestKey);
      if (pending && (result || message.error)) {
        this.codexStartTitles.delete(requestKey);
        const turn = record(result?.turn); const turnId = identifier(turn?.id);
        if (turnId && !this.ignored.has(pending.threadId)) {
          this.codexTurnTitles.set(JSON.stringify([pending.threadId, turnId]), pending.title); this.bound(this.codexTurnTitles);
          this.sessions.get(pending.threadId)?.turnTitle(turnId, pending.title, this.connectionId);
        }
      }
    }
    // History RPC responses never enter the live notification path.
    if (typeof message.method !== 'string' || !params) return;
    const id = identifier(params.threadId); if (!id || this.ignored.has(id)) return;
    if (message.method === 'thread/name/updated') { this.rememberTitle(id, params.threadName); return; }
    const relevant = ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/status/changed', 'serverRequest/resolved', 'error',
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput',
      'item/tool/requestOptionPicker', 'item/tool/call'];
    if (!relevant.includes(message.method)) return;
    const observedQuestion = message.method === 'item/tool/call' || message.method === 'item/tool/requestOptionPicker'
      ? observedCodexQuestion(message as RpcMessage) : undefined;
    if ((message.method === 'item/tool/call' || message.method === 'item/tool/requestOptionPicker') && !observedQuestion) return;
    const session = this.session(id); if (!session) return;
    const turn = record(params.turn);
    const turnId = identifier(turn?.id ?? params.turnId);
    // A live completion or input request also identifies a turn already running when observation began.
    // Unlike an RPC history response, this comes directly from this window's active runtime connection.
    if (turnId && message.method !== 'error') {
      const key = JSON.stringify([id, turnId]); let title = this.codexTurnTitles.get(key);
      if (!title && message.method === 'turn/started') {
        const pending = [...this.codexStartTitles.values()].filter(request => request.threadId === id);
        if (pending.length === 1) title = pending[0]!.title;
      }
      session.start(turnId, this.connectionId, title);
      if (title) session.turnTitle(turnId, title, this.connectionId);
      if (message.method === 'turn/completed') this.codexTurnTitles.delete(key);
    }
    if (observedQuestion) {
      if (turnId && message.id !== undefined) session.waiting({ id: JSON.stringify(message.id), turnId, connectionId: this.connectionId,
        kind: 'question', title: observedQuestion, payload: null });
      return;
    }
    let statusEpisode = this.codexInputEpisodes.get(id)?.episode ?? 0;
    if (message.method === 'thread/status/changed') {
      const status = record(params.status);
      const waiting = status?.type === 'active' && Array.isArray(status.activeFlags) &&
        status.activeFlags.some(flag => flag === 'waitingOnUserInput' || flag === 'waitingOnApproval');
      if (this.codexInputEpisodes.get(id)?.waiting && !waiting) statusEpisode++;
      this.codexInputEpisodes.set(id, { waiting, episode: statusEpisode }); this.bound(this.codexInputEpisodes);
    }
    new CodexAdapter(session, statusEpisode).handle(message as RpcMessage, this.connectionId, true);
  }

  private codexThread(thread: Record<string, unknown>): void {
    const id = identifier(thread.id); if (!id) return;
    if (thread.ephemeral === true || thread.parentThreadId || record(thread.source)?.subAgent) this.ignoreCodexThread(id);
    if (Array.isArray(thread.turns)) for (const value of thread.turns) this.codexAgentItems(record(value)?.items, id);
    if (!this.ignored.has(id) && ('name' in thread || 'preview' in thread)) this.rememberTitle(id, thread.name || thread.preview);
  }

  private codexAgentItems(items: unknown, senderId: string): void {
    if (Array.isArray(items)) for (const item of items) this.codexAgentItem(item, senderId);
  }

  private codexAgentItem(value: unknown, senderId: string): void {
    const item = record(value); if (!item) return;
    if (item.type === 'subAgentActivity') {
      const childId = identifier(item.agentThreadId);
      if (childId && childId !== senderId) this.ignoreCodexThread(childId);
    } else if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds)) {
      // Other collaboration tools can address a parent or peer; only spawn proves a child.
      for (const value of item.receiverThreadIds) {
        const childId = identifier(value);
        if (childId && childId !== senderId && childId !== item.senderThreadId) this.ignoreCodexThread(childId);
      }
    }
  }

  private ignoreCodexThread(id: string): void {
    this.ignored.add(id); this.bound(this.ignored);
    // Metadata can arrive after live items: discard that child's previously admitted state.
    this.sessions.delete(id); this.titles.delete(id); this.codexInputEpisodes.delete(id);
    for (const [key, pending] of this.codexStartTitles) if (pending.threadId === id) this.codexStartTitles.delete(key);
    for (const key of this.codexTurnTitles.keys()) if (JSON.parse(key)[0] === id) this.codexTurnTitles.delete(key);
  }

  private claude(message: Record<string, unknown>): void {
    const sessionId = identifier(message.session_id);
    if (sessionId) this.claudeSessionId = sessionId;
    if (message.type === 'system' && message.subtype === 'init' && sessionId && this.claudeRequests.length) {
      this.session(sessionId)?.start(this.claudeRequests[0]!.id, this.connectionId, this.claudeRequests[0]!.title);
    } else if (message.type === 'assistant' && sessionId) {
      const error = claudeOAuthRefreshError(message); if (!error) return;
      const uuid = identifier(message.uuid); if (!uuid) return;
      const messageKey = JSON.stringify([sessionId, uuid]);
      if (this.claudeErrorMessages.has(messageKey)) return;
      const queued = this.claudeRequests[0]; const userId = identifier(message.user_message_uuid);
      if (userId && queued?.supplied && userId !== queued.id) return;
      const session = this.session(sessionId); if (!session) return;
      if (userId && session.completed.has(userId)) return;
      // A live foreground error also admits a turn already running when observation began.
      const turnId = queued?.id ?? (session.turns.size === 1 ? session.turns.keys().next().value : undefined)
        ?? userId ?? uuid;
      if (!turnId) return;
      const key = JSON.stringify([sessionId, turnId]);
      if (this.claudeErrorTurns.has(key)) {
        this.claudeErrorMessages.add(messageKey); this.bound(this.claudeErrorMessages); return;
      }
      session.start(turnId, this.connectionId, queued?.title);
      if (session.notifyError(turnId, error, this.connectionId, CLAUDE_OAUTH_REFRESH_ERROR)) {
        this.claudeErrorTurns.add(key); this.bound(this.claudeErrorTurns);
        this.claudeErrorMessages.add(messageKey); this.bound(this.claudeErrorMessages);
      }
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
      const previousErrorKey = JSON.stringify([sessionId, previousId]);
      const errorKey = JSON.stringify([sessionId, turnId]);
      const notifiedError = this.claudeErrorTurns.has(previousErrorKey) || this.claudeErrorTurns.has(errorKey);
      if (previousId && previousId !== turnId) {
        // Some extension versions add the UUID after writing the user input. Transfer the observed state.
        const previous = session.turns.get(previousId);
        if (previous) {
          for (const request of [...session.requests.values()]) if (request.turnId === previousId) {
            this.claudeDialogs.delete(request.id); session.resolve(request.id, this.connectionId);
          }
          session.turns.delete(previousId); session.start(turnId, this.connectionId, previous.title); session.body(turnId, previous.text, this.connectionId);
        }
      }
      session.start(turnId, this.connectionId, queued?.title);
      if (queued?.title) session.turnTitle(turnId, queued.title, this.connectionId);
      for (const request of session.requests.values()) if (request.turnId === turnId) this.claudeDialogs.delete(request.id);
      acceptClaudeResult(session, turnId, message as unknown as SDKResultMessage, this.connectionId,
        notifiedError ? CLAUDE_OAUTH_REFRESH_ERROR : undefined);
      this.claudeErrorTurns.delete(previousErrorKey); this.claudeErrorTurns.delete(errorKey);
      this.claudeResults.add(message.uuid as string); this.bound(this.claudeResults);
      if (queued) this.claudeRequests.shift();
    } else if (message.type === 'control_request') {
      this.claudeInput(message);
    } else if (message.type === 'control_cancel_request') {
      const id = identifier(message.request_id);
      if (this.claudeSessionId && id) {
        this.claudeDialogs.delete(id); this.sessions.get(this.claudeSessionId)?.resolve(id, this.connectionId);
      }
    } else if (message.type === 'control_response') {
      const response = record(message.response); const id = identifier(response?.request_id);
      const initialized = !!id && this.claudeInitializations.delete(id);
      if (initialized && response?.subtype === 'success' && this.claudeSessionId) {
        // Only re-delivery belonging to an initialize we actually observed is live input.
        // The SDK may also deliver these IDs as control_request frames; Session deduplicates them.
        for (const name of ['pending_permission_requests', 'pending_user_dialog_requests']) {
          if (Array.isArray(response[name])) for (const pending of response[name]) {
            const envelope = record(pending);
            if (envelope?.type === 'control_request') this.claudeInput(envelope);
          }
        }
      }
      if (id && this.claudeSessionId) {
        const session = this.sessions.get(this.claudeSessionId);
        this.claudeResponse(response);
        if (this.pendingThreads.delete(id) && response?.subtype === 'success') {
          const turn = this.claudeRequests.shift();
          if (turn) {
            this.claudeErrorTurns.delete(JSON.stringify([this.claudeSessionId, turn.id]));
            for (const request of session?.requests.values() ?? []) if (request.turnId === turn.id) this.claudeDialogs.delete(request.id);
            session?.finish(turn.id, 'cancelled', this.connectionId, 'Interrupt acknowledged by the existing Claude runtime');
          }
        }
      }
    }
  }

  private claudeInput(message: Record<string, unknown>): void {
    const request = record(message.request);
    const id = identifier(message.request_id);
    if (!id || !request || !this.claudeSessionId) return;
    let kind: 'question' | 'approval';
    let title: string;
    if (request.subtype === 'can_use_tool') {
      const question = request.tool_name === 'AskUserQuestion';
      const input = record(request.input);
      kind = question ? 'question' : 'approval';
      title = question
        ? inputQuestionText(input?.questions, typeof request.title === 'string' ? request.title : 'Claude needs an answer')
        : typeof request.title === 'string' && request.title.trim() ? request.title : `Claude: ${String(request.tool_name ?? 'tool')} approval`;
    } else if (request.subtype === 'request_user_dialog') {
      const dialogKind = identifier(request.dialog_kind);
      const payload = record(request.payload);
      if (!dialogKind || !payload) return;
      kind = 'question';
      title = inputQuestionText(Array.isArray(payload.questions) ? payload.questions : [payload], `Claude needs an answer (${dialogKind})`);
    } else return;
    const session = this.session(this.claudeSessionId); if (!session) return;
    const turnId = this.claudeRequests[0]?.id ?? [...session.turns.keys()][0] ?? `input:${id}`;
    session.start(turnId, this.connectionId, this.claudeRequests[0]?.title);
    // The original provider UI owns the answer; observation retains no mutable tool payload.
    session.waiting({ id, turnId, connectionId: this.connectionId, kind, title, payload: null });
    if (request.subtype === 'request_user_dialog' && session.requests.has(id)) {
      this.claudeDialogs.add(id); this.bound(this.claudeDialogs);
    }
  }

  private claudeResponse(response: Record<string, unknown> | undefined): void {
    const id = identifier(response?.request_id);
    if (!id || !this.claudeSessionId) return;
    // A dialog error is not a user's choice: Claude discards it and keeps the dialog pending.
    // Keep the existing response semantics for can_use_tool requests.
    if (this.claudeDialogs.has(id) && response?.subtype !== 'success') return;
    this.claudeDialogs.delete(id);
    this.sessions.get(this.claudeSessionId)?.resolve(id, this.connectionId);
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
      if (this.titles.has(id)) session.setTitle(this.titles.get(id), this.connectionId);
    }
    return session;
  }
  private rememberTitle(id: string, value: unknown): void {
    const title = taskTitle(value);
    if (title) { this.titles.set(id, title); this.bound(this.titles); } else this.titles.delete(id);
    this.sessions.get(id)?.setTitle(title, this.connectionId);
  }
  private bound(collection: Map<string, unknown> | Set<string>): void {
    while (collection.size > LIMITS.dedup) collection.delete(collection.keys().next().value!);
  }
  snapshot() { return { provider: this.provider, connectionId: this.connectionId, sessions: this.sessions.size,
    activeTurns: [...this.sessions.values()].reduce((count, s) => count + s.turns.size, 0),
    pendingRequests: [...this.sessions.values()].reduce((count, s) => count + s.requests.size, 0) }; }
  dispose(): void { this.disposed = true; this.sessions.clear(); this.pendingThreads.clear(); this.codexInputEpisodes.clear(); this.ignored.clear(); this.titles.clear();
    this.codexStartTitles.clear(); this.codexTurnTitles.clear(); this.claudeResults.clear(); this.claudeErrorTurns.clear(); this.claudeErrorMessages.clear(); this.claudeInitializations.clear(); this.claudeDialogs.clear(); this.claudeRequests.length = 0; }
}

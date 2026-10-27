import { randomUUID } from 'node:crypto';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { LIMITS } from '../../core/model';
import type { Session } from '../../core/session';
import type { AgentEvents, EventContext } from '../agent-provider';
import { acceptClaudeResult } from './adapter';
import { bound, identifier, record } from '../message';

export class ClaudeEvents implements AgentEvents {
  private readonly pendingInterrupts = new Map<string, boolean>();
  private readonly queuedInputs: { id: string; supplied: boolean }[] = [];
  private readonly receivedResults = new Set<string>();
  private sessionId?: string;
  constructor(private context: EventContext) {}
  outgoing(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'user': {
        // Only identifiers are retained; prompts and tool contents remain in the original transport.
        if (this.queuedInputs.length >= LIMITS.turns) throw new Error('Observed Claude input queue exceeds limit');
        const id = identifier(message.uuid);
        this.queuedInputs.push({ id: id ?? randomUUID(), supplied: !!id });
        const sessionId = identifier(message.session_id) ?? this.sessionId;
        if (sessionId) this.context.session(sessionId)?.start(this.queuedInputs[0]!.id, this.context.connectionId);
        return;
      }
      case 'control_response': {
        if (!this.sessionId) return;
        const response = record(message.response);
        const id = identifier(response?.request_id);
        if (id) this.context.existingSession(this.sessionId)?.resolve(id, this.context.connectionId);
        return;
      }
      case 'control_request': {
        const request = record(message.request);
        if (request?.subtype !== 'interrupt' || !this.sessionId) return;
        // Wait for the explicit control response, rather than treating an outgoing request as acknowledgement.
        const id = identifier(message.request_id);
        if (id) this.pendingInterrupts.set(id, true);
        bound(this.pendingInterrupts);
        return;
      }
    }
  }
  incoming(message: Record<string, unknown>): void {
    const sessionId = identifier(message.session_id);
    if (sessionId) this.sessionId = sessionId;
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && sessionId && this.queuedInputs.length) {
          this.context.session(sessionId)?.start(this.queuedInputs[0]!.id, this.context.connectionId);
        }
        return;
      case 'result':
        if (sessionId) this.acceptResult(message, sessionId);
        return;
      case 'control_request':
        this.acceptToolRequest(message);
        return;
      case 'control_cancel_request':
        if (this.sessionId && identifier(message.request_id)) this.context.existingSession(this.sessionId)?.resolve(message.request_id as string, this.context.connectionId);
        return;
      case 'control_response':
        this.acceptControlResponse(message);
        return;
    }
  }

  private acceptResult(message: Record<string, unknown>, sessionId: string): void {
    const resultId = identifier(message.uuid);
    if (!resultId || typeof message.is_error !== 'boolean' || typeof message.subtype !== 'string') throw new Error('Malformed observed Claude result');
    const validBody = message.subtype === 'success'
      ? typeof message.result === 'string'
      : Array.isArray(message.errors) && message.errors.every(error => typeof error === 'string');
    if (!validBody) throw new Error('Malformed observed Claude result body');
    if (this.receivedResults.has(resultId)) return;
    const session = this.context.session(sessionId); if (!session) return;
    const userMessageId = identifier(message.user_message_uuid);
    const queuedInput = this.queuedInputs[0];
    if (userMessageId && queuedInput?.supplied && queuedInput.id !== userMessageId) return;
    const turnId = userMessageId ?? queuedInput?.id ?? resultId;
    const previousId = queuedInput?.id ?? (session.turns.size === 1 ? session.turns.keys().next().value : undefined);
    this.transferTurn(session, previousId, turnId);
    session.start(turnId, this.context.connectionId);
    acceptClaudeResult(session, turnId, message as unknown as SDKResultMessage, this.context.connectionId);
    this.receivedResults.add(resultId);
    bound(this.receivedResults);
    if (queuedInput) this.queuedInputs.shift();
  }

  private transferTurn(session: Session, previousId: string | undefined, turnId: string): void {
    if (!previousId || previousId === turnId) return;
    // Some extension versions add the UUID after writing the user input. Transfer the observed state.
    const previous = session.turns.get(previousId);
    if (!previous) return;
    for (const request of [...session.requests.values()]) {
      if (request.turnId === previousId) session.resolve(request.id, this.context.connectionId);
    }
    session.turns.delete(previousId);
    session.start(turnId, this.context.connectionId);
    session.body(turnId, previous.text, this.context.connectionId);
  }

  private acceptToolRequest(message: Record<string, unknown>): void {
    const request = record(message.request);
    const id = identifier(message.request_id);
    if (!id || request?.subtype !== 'can_use_tool' || !this.sessionId) return;
    const session = this.context.session(this.sessionId); if (!session) return;
    const turnId = this.queuedInputs[0]?.id ?? [...session.turns.keys()][0] ?? `input:${id}`;
    session.start(turnId, this.context.connectionId);
    const question = request.tool_name === 'AskUserQuestion';
    const input = record(request.input);
    const questions = Array.isArray(input?.questions)
      ? input.questions.map(question => record(question)?.question).filter(title => typeof title === 'string').join('\n')
      : '';
    session.waiting({ id, turnId, connectionId: this.context.connectionId, kind: question ? 'question' : 'approval',
      title: question ? questions || 'Claude needs an answer' : `Claude: ${String(request.tool_name ?? 'tool')} approval`, payload: null });
  }

  private acceptControlResponse(message: Record<string, unknown>): void {
    const response = record(message.response);
    const id = identifier(response?.request_id);
    if (!id || !this.sessionId) return;
    const session = this.context.existingSession(this.sessionId);
    session?.resolve(id, this.context.connectionId);
    if (!this.pendingInterrupts.delete(id) || response?.subtype !== 'success') return;
    const turn = this.queuedInputs.shift();
    if (turn) session?.finish(turn.id, 'cancelled', this.context.connectionId, 'Interrupt acknowledged by the existing Claude runtime');
  }

  dispose(): void {
    this.pendingInterrupts.clear();
    this.receivedResults.clear();
    this.queuedInputs.length = 0;
    this.sessionId = undefined;
  }
}

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { InputRequest, LIMITS } from '../../core/model';
import type { Session } from '../../core/session';
import { AgentProvider } from '../agent-provider';
import type { AgentEvents, AgentInteraction, EventContext, ExecutionContext } from '../agent-provider';
import { ClaudeExecution, acceptClaudeResult } from '../claude';
import { bound, identifier, record } from './message';

export class ClaudeProvider extends AgentProvider {
  readonly id = 'claude';
  readonly extensionId = 'anthropic.claude-code';
  readonly runCommand = 'runClaude';
  matchesProcess(args: readonly string[]): boolean {
    return args.some((arg, i) => arg === '--output-format=stream-json' || arg === '--output-format' && args[i + 1] === 'stream-json');
  }
  runtimeDirectory(): string { return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'); }
  createEvents(context: EventContext): AgentEvents { return new ClaudeEvents(context); }
  createExecution(context: ExecutionContext): ClaudeExecution {
    const session = context.createSession(context.sessionId ?? randomUUID(), randomUUID());
    return new ClaudeExecution({ cwd: context.cwd, executable: context.config('claudeExecutable', ''),
      maxTurns: context.config('claudeMaxTurns', 50), session, resume: !!context.sessionId });
  }
  protected approvalResponse(request: InputRequest, allow: boolean): unknown {
    if (allow) return { behavior: 'allow', updatedInput: (request.payload as { input: unknown }).input };
    return { behavior: 'deny', message: 'Denied by user' };
  }
  protected async answerQuestions(request: InputRequest, interaction: AgentInteraction): Promise<unknown> {
    const payload = request.payload as { input: { questions?: { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] } };
    const claudeAnswers: Record<string, string> = {};
    if (!payload.input.questions?.length) throw new Error('Unsupported Claude question schema');
    for (const q of payload.input.questions) {
      const answer = await interaction.question(q.question, q.options ?? [], { multiSelect: !!q.multiSelect, secret: false });
      if (!answer) return;
      claudeAnswers[q.question] = answer.join(', ');
    }
    return { behavior: 'allow', updatedInput: { ...payload.input, answers: claudeAnswers } };
  }
}

class ClaudeEvents implements AgentEvents {
  private readonly pendingThreads = new Map<string, boolean>();
  private readonly claudeRequests: { id: string; supplied: boolean }[] = [];
  private readonly claudeResults = new Set<string>();
  private claudeSessionId?: string;
  constructor(private context: EventContext) {}
  outgoing(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'user': {
        // Only identifiers are retained; prompts and tool contents remain in the original transport.
        if (this.claudeRequests.length >= LIMITS.turns) throw new Error('Observed Claude input queue exceeds limit');
        const id = identifier(message.uuid);
        this.claudeRequests.push({ id: id ?? randomUUID(), supplied: !!id });
        const sessionId = identifier(message.session_id) ?? this.claudeSessionId;
        if (sessionId) this.context.session(sessionId)?.start(this.claudeRequests[0]!.id, this.context.connectionId);
        return;
      }
      case 'control_response': {
        if (!this.claudeSessionId) return;
        const response = record(message.response); const id = identifier(response?.request_id);
        if (id) this.context.existingSession(this.claudeSessionId)?.resolve(id, this.context.connectionId);
        return;
      }
      case 'control_request': {
        const request = record(message.request);
        if (request?.subtype !== 'interrupt' || !this.claudeSessionId) return;
        // Wait for the explicit control response, rather than treating an outgoing request as acknowledgement.
        const id = identifier(message.request_id);
        if (id) this.pendingThreads.set(id, true);
        bound(this.pendingThreads);
        return;
      }
    }
  }
  incoming(message: Record<string, unknown>): void {
    const sessionId = identifier(message.session_id);
    if (sessionId) this.claudeSessionId = sessionId;
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && sessionId && this.claudeRequests.length) {
          this.context.session(sessionId)?.start(this.claudeRequests[0]!.id, this.context.connectionId);
        }
        return;
      case 'result':
        if (sessionId) this.claudeResult(message, sessionId);
        return;
      case 'control_request':
        this.claudeInputRequest(message);
        return;
      case 'control_cancel_request':
        if (this.claudeSessionId && identifier(message.request_id)) this.context.existingSession(this.claudeSessionId)?.resolve(message.request_id as string, this.context.connectionId);
        return;
      case 'control_response':
        this.claudeControlResponse(message);
        return;
    }
  }

  private claudeResult(message: Record<string, unknown>, sessionId: string): void {
    const resultId = identifier(message.uuid);
    if (!resultId || typeof message.is_error !== 'boolean' || typeof message.subtype !== 'string') throw new Error('Malformed observed Claude result');
    const validBody = message.subtype === 'success'
      ? typeof message.result === 'string'
      : Array.isArray(message.errors) && message.errors.every(error => typeof error === 'string');
    if (!validBody) throw new Error('Malformed observed Claude result body');
    if (this.claudeResults.has(resultId)) return;
    const session = this.context.session(sessionId); if (!session) return;
    const userId = identifier(message.user_message_uuid);
    const queued = this.claudeRequests[0];
    if (userId && queued?.supplied && queued.id !== userId) return;
    const turnId = userId ?? queued?.id ?? resultId;
    const previousId = queued?.id ?? (session.turns.size === 1 ? session.turns.keys().next().value : undefined);
    this.transferClaudeTurn(session, previousId, turnId);
    session.start(turnId, this.context.connectionId);
    acceptClaudeResult(session, turnId, message as unknown as SDKResultMessage, this.context.connectionId);
    this.claudeResults.add(resultId); bound(this.claudeResults);
    if (queued) this.claudeRequests.shift();
  }

  private transferClaudeTurn(session: Session, previousId: string | undefined, turnId: string): void {
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

  private claudeInputRequest(message: Record<string, unknown>): void {
    const request = record(message.request);
    const id = identifier(message.request_id);
    if (!id || request?.subtype !== 'can_use_tool' || !this.claudeSessionId) return;
    const session = this.context.session(this.claudeSessionId); if (!session) return;
    const turnId = this.claudeRequests[0]?.id ?? [...session.turns.keys()][0] ?? `input:${id}`;
    session.start(turnId, this.context.connectionId);
    const question = request.tool_name === 'AskUserQuestion';
    const input = record(request.input);
    const questions = Array.isArray(input?.questions) ? input.questions.map(q => record(q)?.question).filter(q => typeof q === 'string').join('\n') : '';
    session.waiting({ id, turnId, connectionId: this.context.connectionId, kind: question ? 'question' : 'approval',
      title: question ? questions || 'Claude needs an answer' : `Claude: ${String(request.tool_name ?? 'tool')} approval`, payload: null });
  }

  private claudeControlResponse(message: Record<string, unknown>): void {
    const response = record(message.response);
    const id = identifier(response?.request_id);
    if (!id || !this.claudeSessionId) return;
    const session = this.context.existingSession(this.claudeSessionId);
    session?.resolve(id, this.context.connectionId);
    if (!this.pendingThreads.delete(id) || response?.subtype !== 'success') return;
    const turn = this.claudeRequests.shift();
    if (turn) session?.finish(turn.id, 'cancelled', this.context.connectionId, 'Interrupt acknowledged by the existing Claude runtime');
  }

  dispose(): void { this.pendingThreads.clear(); this.claudeResults.clear(); this.claudeRequests.length = 0; this.claudeSessionId = undefined; }
}

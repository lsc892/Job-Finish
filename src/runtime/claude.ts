import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult, Query, SDKMessage, SDKResultMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk' with { "resolution-mode": "import" };
import { Session } from '../core/session';
import { LIMITS } from '../core/model';

/** An assistant message is not a result. A bound query has exactly one foreground turn. */
export function acceptClaudeResult(session: Session, requestId: string, message: SDKResultMessage, connectionId: string): void {
  if (message.session_id !== session.binding.sessionId) throw new Error('Claude session identity mismatch');
  if (!message.uuid || (message.user_message_uuid && message.user_message_uuid !== requestId)) throw new Error('Claude result is not bound to this execution');
  const success = message.subtype === 'success' && message.is_error === false;
  const body = message.subtype === 'success' ? message.result : message.errors.join('\n');
  session.body(requestId, body, connectionId);
  session.finish(requestId, success ? 'completed' : 'error', connectionId,
    success ? undefined : message.subtype === 'error_max_turns' ? 'Execution turn limit reached (not account quota)' : message.subtype, message.uuid);
}
export interface ClaudeOptions { cwd: string; executable?: string; maxTurns: number; session: Session; resume: boolean; model?: string; onEvent?: (message: SDKMessage) => void; createQuery?: typeof query }
interface ExecutionContext { requestId: string; connectionId: string; acceptingInput: boolean }
export class ClaudeExecution {
  readonly session: Session;
  private query?: Query;
  private runTask?: Promise<void>;
  private pending = new Map<string, { context: ExecutionContext; resolve: (answer: PermissionResult) => void; cleanup: () => void }>();
  private aborted = false;
  private context?: ExecutionContext;
  private resume: boolean;
  private disposed = false;
  constructor(private options: ClaudeOptions) { this.session = options.session; this.resume = options.resume; }
  async run(prompt: string): Promise<void> {
    if (this.disposed) throw new Error('Claude execution released');
    if (!this.session.valid(this.session.binding.connectionId)) throw new Error('Session ownership lost');
    if (this.runTask || this.session.turns.size) throw new Error('Session has an active or unresolved execution');
    this.runTask = this.consume(prompt);
    // Attach error handler immediately; the command returns when execution has started.
    void this.runTask.then(() => { this.runTask = undefined; }, error => {
      try { this.session.disconnected(error); } catch (saveError) { this.session.diagnostics.add(saveError); }
      this.runTask = undefined;
    });
  }
  private async consume(prompt: string): Promise<void> {
    const createQuery = this.options.createQuery ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    if (this.disposed) return;
    if (!this.session.valid(this.session.binding.connectionId)) throw new Error('Session ownership lost');
    const requestId = randomUUID(); this.aborted = false;
    const connectionId = randomUUID(); this.session.reconnect(connectionId); this.session.start(requestId, connectionId);
    const context: ExecutionContext = { requestId, connectionId, acceptingInput: true }; this.context = context;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', uuid: requestId, session_id: '', parent_tool_use_id: null, message: { role: 'user', content: prompt } };
    }
    try {
      this.query = createQuery({ prompt: input(), options: {
        cwd: this.options.cwd, maxTurns: this.options.maxTurns, permissionMode: 'default',
        env: { JOB_FINISH_OWNED_EXECUTION: '1' },
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.resume ? { resume: this.session.binding.sessionId } : { sessionId: this.session.binding.sessionId }),
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
        canUseTool: this.canUseTool(context), settingSources: ['user', 'project', 'local'],
        stderr: message => this.session.diagnostics.add(message),
      } });
      for await (const message of this.query) {
        if (this.aborted) break;
        this.handle(message, context);
      }
      if (this.session.turns.has(requestId)) this.session.disconnected('Claude stream ended without a confirmed result');
    } finally {
      context.acceptingInput = false; this.clearPending();
      try { this.query?.close(); } finally { this.query = undefined; this.context = undefined; this.resume = true; }
    }
  }
  private handle(message: SDKMessage, context: ExecutionContext): void {
    this.options.onEvent?.(message);
    if ('session_id' in message && message.session_id !== this.session.binding.sessionId) throw new Error('Claude session identity mismatch');
    if (message.type === 'result') {
      context.acceptingInput = false;
      acceptClaudeResult(this.session, context.requestId, message, context.connectionId); this.clearPending();
    } else if (message.type === 'rate_limit_event') {
      this.session.diagnostics.add(`Claude rate limit advisory: ${JSON.stringify(message)}`);
    }
  }
  private accepts(context: ExecutionContext): boolean {
    return this.context === context && context.acceptingInput && !this.aborted && !this.disposed
      && this.session.valid(context.connectionId) && this.session.turns.has(context.requestId);
  }
  private canUseTool(context: ExecutionContext): CanUseTool { return async (toolName, input, options) => {
    if (!this.accepts(context) || options.signal.aborted) return { behavior: 'deny', message: 'Execution no longer active' };
    if (this.pending.size >= LIMITS.requests || Buffer.byteLength(JSON.stringify(input)) > LIMITS.textBytes) throw new Error('Claude input request exceeds bounded capacity');
    const id = options.requestId || options.toolUseID;
    // SDK deduplicates in-flight control requests before invoking the callback.
    if (this.pending.has(id)) throw new Error('Duplicate concurrent SDK control callback');
    return new Promise<PermissionResult>(resolve => {
      const abort = () => { this.settle(id, { behavior: 'deny', message: 'Request withdrawn' }); };
      this.pending.set(id, { context, resolve, cleanup: () => options.signal.removeEventListener('abort', abort) });
      options.signal.addEventListener('abort', abort, { once: true });
      try {
        this.session.waiting({ id, turnId: context.requestId, connectionId: context.connectionId,
          kind: toolName === 'AskUserQuestion' ? 'question' : 'approval', title: options.title ?? `${toolName}: ${JSON.stringify(input)}`,
          payload: { toolName, input } });
        if (options.signal.aborted || !this.session.requests.has(id)) abort();
      } catch (error) {
        this.session.diagnostics.add(error); this.settle(id, { behavior: 'deny', message: 'Cannot record input request' });
      }
    });
  }; }
  respond(id: string, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending || !this.accepts(pending.context) || !this.session.requests.has(id)) {
      this.settle(id, { behavior: 'deny', message: 'Request no longer active or owned' });
      throw new Error('Request no longer pending or owned');
    }
    this.settle(id, result as PermissionResult);
  }
  private settle(id: string, result: PermissionResult): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); pending.cleanup();
    try { this.session.resolve(id, pending.context.connectionId); }
    catch (error) { this.session.diagnostics.add(error); result = { behavior: 'deny', message: 'Cannot record input response' }; }
    finally { pending.resolve(result); }
  }
  async cancel(): Promise<void> {
    const context = this.context;
    if (!this.query || !context || !this.accepts(context)) throw new Error('No active owned Claude execution');
    await this.query.interrupt(); // Explicit SDK acknowledgment, never infer cancellation from EOF.
    // A result may arrive while awaiting the interrupt acknowledgment.
    if (this.context !== context) return;
    context.acceptingInput = false;
    try {
      if (this.session.turns.has(context.requestId)) this.session.finish(context.requestId, 'cancelled', context.connectionId, 'User interrupt acknowledged by SDK');
    } finally { this.clearPending(); }
  }
  private clearPending(): void { for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message: 'Execution finished or disconnected' }); }
  async reconnect(): Promise<void> { throw new Error('The SDK cannot verify an interrupted foreground result via history. Unknown execution is retained; release it explicitly before starting a new session.'); }
  async readResult(): Promise<undefined> { return undefined; }
  dispose(): void {
    this.disposed = true; this.aborted = true; this.clearPending();
    try { this.query?.close(); } finally { this.session.disconnected('Claude execution released'); }
  }
}

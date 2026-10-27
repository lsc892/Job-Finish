// Claude SDK 질의와 도구 권한 요청의 수명을 세션 실행에 연결한다.
import { randomUUID } from 'node:crypto';
import type { Query, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk' with { "resolution-mode": "import" };
import { Session } from '../../core/session';
import { AgentRuntime, RuntimeOptions } from '../execution';
import { acceptClaudeResult } from './adapter';
import { ClaudePermissions, ClaudeTurnContext } from './permissions';

export interface ClaudeOptions extends RuntimeOptions<SDKMessage> { maxTurns: number; session: Session; resume: boolean; createQuery?: typeof query }
/** 소유한 Claude 세션의 SDK 질의·결과·도구 권한·중단 수명을 관리한다. */
export class ClaudeExecution extends AgentRuntime {
  readonly session: Session;
  private query?: Query;
  private runTask?: Promise<void>;
  private readonly permissions: ClaudePermissions;
  private aborted = false;
  private context?: ClaudeTurnContext;
  private resume: boolean;
  private disposed = false;
  constructor(private readonly options: ClaudeOptions) {
    super();
    this.session = options.session;
    this.resume = options.resume;
    this.permissions = new ClaudePermissions(this.session, context => this.accepts(context));
  }
  async run(prompt: string): Promise<void> {
    if (this.disposed) throw new Error('Claude execution released');
    this.assertOwnership();
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
    this.assertOwnership();
    const requestId = randomUUID(); this.aborted = false;
    const connectionId = randomUUID(); this.session.reconnect(connectionId); this.session.start(requestId, connectionId);
    const context: ClaudeTurnContext = { requestId, connectionId, acceptingInput: true }; this.context = context;
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
        canUseTool: this.permissions.forTurn(context), settingSources: ['user', 'project', 'local'],
        stderr: message => this.session.diagnostics.add(message),
      } });
      for await (const message of this.query) {
        if (this.aborted) break;
        this.handle(message, context);
      }
      if (this.session.turns.has(requestId)) this.session.disconnected('Claude stream ended without a confirmed result');
    } finally {
      context.acceptingInput = false; this.permissions.clear();
      try { this.query?.close(); } finally { this.query = undefined; this.context = undefined; this.resume = true; }
    }
  }
  private handle(message: SDKMessage, context: ClaudeTurnContext): void {
    this.options.onEvent?.(message);
    if ('session_id' in message && message.session_id !== this.session.binding.sessionId) throw new Error('Claude session identity mismatch');
    switch (message.type) {
      case 'result':
        context.acceptingInput = false;
        acceptClaudeResult(this.session, context.requestId, message, context.connectionId);
        this.permissions.clear();
        return;
      case 'rate_limit_event':
        this.session.diagnostics.add(`Claude rate limit advisory: ${JSON.stringify(message)}`);
        return;
    }
  }
  private accepts(context: ClaudeTurnContext): boolean {
    return this.context === context && context.acceptingInput && !this.aborted && !this.disposed
      && this.session.valid(context.connectionId) && this.session.turns.has(context.requestId);
  }
  respond(id: string, result: unknown): void { this.permissions.respond(id, result); }
  async cancel(): Promise<void> {
    const context = this.context;
    if (!this.query || !context || !this.accepts(context)) throw new Error('No active owned Claude execution');
    await this.query.interrupt(); // Explicit SDK acknowledgment, never infer cancellation from EOF.
    // A result may arrive while awaiting the interrupt acknowledgment.
    if (this.context !== context) return;
    context.acceptingInput = false;
    try {
      if (this.session.turns.has(context.requestId)) this.session.finish(context.requestId, 'cancelled', context.connectionId, 'User interrupt acknowledged by SDK');
    } finally { this.permissions.clear(); }
  }
  async reconnect(): Promise<void> { throw new Error('The SDK cannot verify an interrupted foreground result via history. Unknown execution is retained; release it explicitly before starting a new session.'); }
  async readResult(): Promise<undefined> { return undefined; }
  dispose(): void {
    this.disposed = true; this.aborted = true; this.permissions.clear();
    try { this.query?.close(); } finally { this.session.disconnected('Claude execution released'); }
  }
}

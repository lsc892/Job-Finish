import { randomUUID } from 'node:crypto';
import type { Thread } from '../../protocol/v2/Thread';
import type { Turn } from '../../protocol/v2/Turn';
import type { ThreadStartParams } from '../../protocol/v2/ThreadStartParams';
import type { ThreadResumeParams } from '../../protocol/v2/ThreadResumeParams';
import type { TurnStartParams } from '../../protocol/v2/TurnStartParams';
import { Session } from '../../core/session';
import { RpcError, RpcMessage, StdioRpc } from '../transport';
import { CodexAdapter, codexId } from './adapter';
import { CodexConnection, CodexConnectionOptions } from './connection';
import { CodexReconciliation } from './reconciliation';
import { AgentRuntime, RuntimeOptions } from '../execution';

export interface CodexOptions extends CodexConnectionOptions, RuntimeOptions<RpcMessage> {
  mode?: 'default' | 'plan';
  sandbox?: 'read-only' | 'workspace-write';
  permissionRequests?: boolean;
  createSession: (sessionId: string, connectionId: string) => Session;
}

/** Coordinates thread and turn commands; protocol, connection and history have separate owners. */
export class CodexExecution extends AgentRuntime {
  session: Session | undefined;
  private adapter?: CodexAdapter;
  private reconciliation?: CodexReconciliation;
  private readonly connection: CodexConnection;
  private starting = false;
  private effectiveModel?: string;

  constructor(private readonly options: CodexOptions) {
    super();
    this.connection = new CodexConnection(options, {
      message: message => this.handle(message),
      disconnected: reason => this.session?.disconnected(reason),
      recover: () => this.recover(),
      canRecover: () => !!this.session,
    });
  }

  async open(sessionId?: string): Promise<void> {
    try {
      await this.connection.open();
      const rpc = this.connection.rpc!;
      if (sessionId) {
        this.bindSession(sessionId, rpc);
        await this.resumeThread(rpc);
      } else {
        const params: ThreadStartParams = { cwd: this.options.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: this.options.sandbox ?? 'workspace-write',
          ...(this.options.permissionRequests ? { config: { 'features.request_permissions_tool': true } } : {}), ...(this.options.model ? { model: this.options.model } : {}) };
        const result = await rpc.request<{ thread: Thread; model?: string }>('thread/start', params);
        this.effectiveModel = result.model;
        this.bindSession(codexId(result.thread?.id), this.connection.rpc!);
      }
      this.connection.activate();
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  private bindSession(sessionId: string, rpc: StdioRpc): void {
    this.session = this.options.createSession(sessionId, rpc.connectionId);
    this.adapter = new CodexAdapter(this.session);
    this.reconciliation = new CodexReconciliation(this.adapter, this.options.diagnostic, connection => this.connection.isCurrent(connection));
  }

  private async resumeThread(rpc: StdioRpc): Promise<void> {
    const params: ThreadResumeParams = { threadId: this.session!.binding.sessionId, cwd: this.options.cwd, approvalsReviewer: 'user', excludeTurns: true };
    const result = await rpc.request<{ thread: Thread; model?: string }>('thread/resume', params);
    this.effectiveModel = result.model;
    await this.reconciliation!.reconcile(result.thread, rpc);
  }

  async run(prompt: string): Promise<void> {
    if (!this.connection.ready || !this.session) throw new Error('Reconnect the Codex session first');
    if (this.starting || this.session.turns.size || this.session.pendingStart) throw new Error('Session has an active or unresolved turn/start request');
    const model = this.options.model || this.effectiveModel;
    if (this.options.mode && !model) throw new Error('Codex did not provide model metadata for the selected mode');
    this.starting = true;
    const rpc = this.connection.rpc!;
    const startRequestId = randomUUID();
    try {
      this.session.beginStart(startRequestId, rpc.connectionId);
      const params: TurnStartParams = { threadId: this.session.binding.sessionId, clientUserMessageId: startRequestId, input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(this.options.mode ? { collaborationMode: { mode: this.options.mode, settings: { model: model!, reasoning_effort: null, developer_instructions: null } } } : {}) };
      const result = await rpc.request<{ turn: Turn }>('turn/start', params);
      if (rpc !== this.connection.rpc || !rpc.connected || !this.session.valid(rpc.connectionId)) throw new Error('Start response connection changed; reconcile the saved request');
      this.session.start(codexId(result.turn?.id), rpc.connectionId);
      this.adapter!.reconcileTurn(result.turn, rpc.connectionId);
    } catch (error) {
      this.handleStartFailure(error, rpc, startRequestId);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private handleStartFailure(error: unknown, rpc: StdioRpc, startRequestId: string): void {
    if (rpc !== this.connection.rpc || !this.session!.valid(rpc.connectionId)) {
      this.options.diagnostic.add(error);
    } else if (error instanceof RpcError) {
      // Request failure has its own identity, never invent a provider turn ID.
      this.options.diagnostic.add(`turn/start rejected (${error.code}): ${error.message}`);
      this.session!.startRejected(startRequestId, error.message, rpc.connectionId);
    } else {
      this.session!.disconnected(error);
    }
  }

  async cancel(): Promise<void> {
    const rpc = this.connection.rpc;
    if (!this.connection.ready || !rpc?.connected || !this.session?.valid(rpc.connectionId)) throw new Error('No active owned Codex connection');
    const turn = [...this.session.turns.values()].find(turn => turn.status !== 'unknown');
    if (!turn) throw new Error('No confirmed active Codex turn');
    await rpc.request('turn/interrupt', { threadId: this.session.binding.sessionId, turnId: turn.id });
  }

  respond(requestId: string, result: unknown): void {
    const request = this.session?.requests.get(requestId);
    if (!request || !this.session!.valid(request.connectionId)) throw new Error('Request no longer pending');
    const message = request.payload as RpcMessage;
    this.connection.rpc!.respond(message.id!, result);
    this.session!.resolve(requestId, request.connectionId);
    this.connection.rememberAnswer(requestId, result);
  }

  reconnect(): Promise<void> { return this.connection.reconnect(); }

  private async recover(): Promise<void> {
    if (!this.session || this.connection.disposed) throw new Error('No session to recover');
    this.assertOwnership();
    this.session.disconnected('Reconnecting; active outcomes require reconciliation');
    this.connection.close();
    try {
      await this.connection.open();
      this.session.reconnect(this.connection.rpc!.connectionId);
      await this.resumeThread(this.connection.rpc!);
      this.connection.activate();
    } catch (error) {
      this.connection.close();
      this.session.disconnected(error);
      throw error;
    }
  }

  private handle(message: RpcMessage): void {
    if (!this.session?.valid(this.connection.rpc!.connectionId)) return;
    this.options.onEvent?.(message);
    if (this.connection.replayAnswer(message)) return;
    if (message.method === 'turn/completed') this.reconciliation!.reconcileConflictingResult(message, this.connection.rpc!);
    this.adapter!.handle(message, this.connection.rpc!.connectionId, this.starting);
    if (message.id !== undefined && message.method && !this.session.requests.has(JSON.stringify(message.id))) {
      this.connection.rpc!.reject(message.id, 'Unsupported or unbound Job-Finish request');
      this.options.diagnostic.add(`Unsupported server request: ${message.method}`);
    }
  }

  async readResult(turnId: string): Promise<string | undefined> {
    if (!this.connection.ready) return undefined;
    return this.reconciliation!.readResult(turnId, this.connection.rpc!);
  }

  dispose(): void { this.connection.dispose(); }
}

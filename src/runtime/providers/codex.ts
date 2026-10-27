import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InputRequest } from '../../core/model';
import type { ToolRequestUserInputParams } from '../../protocol/v2/ToolRequestUserInputParams';
import { AgentProvider } from '../agent-provider';
import type { AgentEvents, AgentInteraction, EventContext, ExecutionContext } from '../agent-provider';
import { CodexAdapter, CodexExecution, codexApprovalResponse } from '../codex';
import type { RpcMessage } from '../transport';
import { bound, identifier, record } from './message';

export class CodexProvider extends AgentProvider {
  readonly id = 'codex';
  readonly extensionId = 'openai.chatgpt';
  readonly runCommand = 'runCodex';
  matchesProcess(args: readonly string[]): boolean { return args.includes('app-server'); }
  runtimeDirectory(): string { return process.env.CODEX_HOME ?? join(homedir(), '.codex'); }
  createEvents(context: EventContext): AgentEvents { return new CodexEvents(context); }
  createExecution(context: ExecutionContext): CodexExecution {
    return new CodexExecution({ cwd: context.cwd, executable: context.config('codexExecutable', ''),
      model: context.config('codexModel', '') || undefined, mode: context.config('codexMode', 'default'),
      diagnostic: context.diagnostics, createSession: context.createSession });
  }
  protected approvalResponse(request: InputRequest, allow: boolean): unknown {
    return codexApprovalResponse(request.payload as RpcMessage, allow);
  }
  protected async answerQuestions(request: InputRequest, interaction: AgentInteraction): Promise<unknown> {
    const answers: Record<string, { answers: string[] }> = {};
    const params = (request.payload as RpcMessage).params as ToolRequestUserInputParams;
    for (const q of params.questions) {
      const answer = await interaction.question(q.question, q.options ?? [], { multiSelect: false, secret: q.isSecret });
      if (!answer) return;
      answers[q.id] = { answers: answer };
    }
    return { answers };
  }
}

class CodexEvents implements AgentEvents {
  private readonly pendingThreads = new Map<string, boolean>();
  private readonly ignored = new Set<string>();
  constructor(private context: EventContext) {}
  outgoing(message: Record<string, unknown>): void {
    if (message.method === 'thread/start' && message.id !== undefined) {
      const params = record(message.params);
      this.pendingThreads.set(JSON.stringify(message.id), params?.ephemeral === true);
      bound(this.pendingThreads);
    }
  }
  incoming(message: Record<string, unknown>): void {
    const params = record(message.params);
    const result = record(message.result);
    const thread = record(params?.thread ?? result?.thread);
    if (thread && identifier(thread.id)) {
      const pendingKey = JSON.stringify(message.id);
      if (thread.ephemeral === true || thread.parentThreadId || record(thread.source)?.subAgent || this.pendingThreads.get(pendingKey)) {
        this.ignored.add(thread.id as string); bound(this.ignored);
      }
      this.pendingThreads.delete(pendingKey);
    }
    // History RPC responses never enter the live notification path.
    if (typeof message.method !== 'string' || !params) return;
    const id = identifier(params.threadId); if (!id || this.ignored.has(id)) return;
    const relevant = ['turn/started', 'turn/completed', 'item/completed', 'serverRequest/resolved', 'error',
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!relevant.includes(message.method)) return;
    const session = this.context.session(id); if (!session) return;
    const turn = record(params.turn);
    const turnId = identifier(turn?.id ?? params.turnId);
    // A live completion or input request also identifies a turn already running when observation began.
    // Unlike an RPC history response, this comes directly from this window's active runtime connection.
    if (turnId && message.method !== 'error') session.start(turnId, this.context.connectionId);
    new CodexAdapter(session).handle(message as RpcMessage, this.context.connectionId, true);
  }

  dispose(): void { this.pendingThreads.clear(); this.ignored.clear(); }
}

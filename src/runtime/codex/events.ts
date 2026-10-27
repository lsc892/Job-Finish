import type { AgentEvents, EventContext } from '../agent-provider';
import { CodexAdapter } from './adapter';
import type { RpcMessage } from '../transport';
import { bound, identifier, record } from '../message';

export class CodexEvents implements AgentEvents {
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
    this.recordThreadExclusion(message, params);
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

  private recordThreadExclusion(message: Record<string, unknown>, params: Record<string, unknown> | undefined): void {
    const result = record(message.result);
    const thread = record(params?.thread ?? result?.thread);
    if (!thread || !identifier(thread.id)) return;
    const pendingKey = JSON.stringify(message.id);
    if (thread.ephemeral === true || thread.parentThreadId || record(thread.source)?.subAgent || this.pendingThreads.get(pendingKey)) {
      this.ignored.add(thread.id as string);
      bound(this.ignored);
    }
    this.pendingThreads.delete(pendingKey);
  }

  dispose(): void { this.pendingThreads.clear(); this.ignored.clear(); }
}

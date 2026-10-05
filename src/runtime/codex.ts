import type { InitializeParams } from '../protocol/InitializeParams';
import type { Thread } from '../protocol/v2/Thread';
import type { Turn } from '../protocol/v2/Turn';
import type { ThreadStartParams } from '../protocol/v2/ThreadStartParams';
import type { TurnStartParams } from '../protocol/v2/TurnStartParams';
import type { PermissionsRequestApprovalParams } from '../protocol/v2/PermissionsRequestApprovalParams';
import type { PermissionsRequestApprovalResponse } from '../protocol/v2/PermissionsRequestApprovalResponse';
import { Session } from '../core/session';
import { Diagnostics, LIMITS, TerminalStatus } from '../core/model';
import { EventQueue, RpcError, RpcMessage, StdioRpc } from './transport';
import { codexCommand } from './executable';
import { randomUUID } from 'node:crypto';

export function codexStatus(value: string): TerminalStatus | undefined {
  switch (value) { case 'completed': return 'completed'; case 'failed': return 'error'; case 'interrupted': return 'cancelled'; default: return undefined; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Codex object');
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Missing Codex identifier'); return value; }

export function codexApprovalResponse(message: RpcMessage, allow: boolean): unknown {
  if (message.method === 'item/permissions/requestApproval') {
    const { permissions } = message.params as PermissionsRequestApprovalParams;
    object(permissions);
    return { scope: 'turn', permissions: allow ? {
      ...(permissions.network ? { network: permissions.network } : {}),
      ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
    } : {} } satisfies PermissionsRequestApprovalResponse;
  }
  return { decision: allow ? 'accept' : 'decline' };
}

/** Shared by live execution and protocol fixture verification. */
export class CodexAdapter {
  constructor(readonly session: Session) {}
  handle(message: RpcMessage, connectionId: string, admitStarted = false): void {
    if (!this.session.valid(connectionId)) return;
    const methods = ['turn/started', 'turn/completed', 'item/completed', 'serverRequest/resolved', 'error',
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!methods.includes(message.method ?? '')) return;
    const p = object(message.params);
    if (id(p.threadId) !== this.session.binding.sessionId) return;
    if (message.method === 'turn/started') {
      const turn = object(p.turn);
      if (admitStarted) this.session.start(id(turn.id), connectionId);
      else this.session.running(id(turn.id), connectionId);
    } else if (message.method === 'item/completed') {
      const item = object(p.item);
      if (item.type === 'agentMessage' && item.phase !== 'commentary') {
        if (typeof item.text !== 'string') throw new Error('Malformed agent message');
        this.session.body(id(p.turnId), item.text, connectionId);
      }
    } else if (message.method === 'turn/completed') {
      this.reconcileTurn(p.turn as Turn, connectionId);
    } else if (message.method === 'serverRequest/resolved') {
      this.session.resolve(JSON.stringify(p.requestId), connectionId);
    } else if (message.method === 'error') {
      this.session.diagnostics.add(`Codex non-terminal error: ${JSON.stringify(p.error)}`);
    } else if (message.id !== undefined) {
      const turnId = id(p.turnId);
      const question = message.method === 'item/tool/requestUserInput';
      this.session.waiting({ id: JSON.stringify(message.id), turnId, connectionId,
        kind: question ? 'question' : 'approval', payload: message,
        title: question ? JSON.stringify(p.questions) : String(p.command ?? p.reason ?? 'File change approval') });
    }
  }
  reconcileTurn(value: Turn, connectionId: string): void {
    const turn = object(value); const turnId = id(turn.id);
    const status = codexStatus(String(turn.status));
    if (!status) {
      if (turn.status !== 'inProgress') throw new Error(`Unknown Codex turn status: ${turn.status}`);
      this.session.running(turnId, connectionId); return;
    }
    if (Array.isArray(turn.items)) for (const item of turn.items) {
      const entry = object(item);
      if (entry.type === 'agentMessage' && entry.phase !== 'commentary' && typeof entry.text === 'string') this.session.body(turnId, entry.text, connectionId);
    }
    let detail: string | undefined;
    if (turn.error) {
      const error = object(turn.error);
      const code = typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : JSON.stringify(error.codexErrorInfo);
      detail = `${code || 'Codex error'}: ${typeof error.message === 'string' ? error.message : 'No error message received'}`;
    }
    this.session.finish(turnId, status, connectionId, detail);
  }
}

export interface CodexOptions { cwd: string; executable?: string; model?: string; mode?: 'default' | 'plan'; sandbox?: 'read-only' | 'workspace-write'; permissionRequests?: boolean; onEvent?: (message: RpcMessage) => void; diagnostic: Diagnostics; createSession: (sessionId: string, connectionId: string) => Session }
export class CodexExecution {
  session?: Session;
  private adapter?: CodexAdapter;
  private rpc?: StdioRpc;
  private readonly queue = new EventQueue();
  private ready = false;
  private starting = false;
  private disposed = false;
  private answered = new Map<string, unknown>();
  private answeredBytes = 0;
  private effectiveModel?: string;
  constructor(private options: CodexOptions) {}
  async open(): Promise<void> {
    try {
      await this.connect();
      const p: ThreadStartParams = { cwd: this.options.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: this.options.sandbox ?? 'workspace-write',
        ...(this.options.permissionRequests ? { config: { 'features.request_permissions_tool': true } } : {}), ...(this.options.model ? { model: this.options.model } : {}) };
      const result = await this.rpc!.request<{ thread: Thread; model?: string }>('thread/start', p);
      this.effectiveModel = result.model;
      this.session = this.options.createSession(id(result.thread?.id), this.rpc!.connectionId);
      this.adapter = new CodexAdapter(this.session);
      this.ready = true; this.queue.drain(message => this.handle(message));
    } catch (e) { this.rpc?.dispose(); this.queue.clear(); throw e; }
  }
  private async connect(): Promise<void> {
    this.ready = false; this.queue.clear(); this.answered.clear(); this.answeredBytes = 0;
    const rpc = new StdioRpc(message => {
      if (rpc !== this.rpc || this.disposed) return;
      if (this.ready) this.handle(message); else this.queue.push(message);
    }, error => {
      if (rpc !== this.rpc || this.disposed) return;
      this.ready = false; this.queue.clear(); this.session?.disconnected(error); this.options.diagnostic.add(error);
    }, message => this.options.diagnostic.add(message));
    this.rpc = rpc;
    const command = codexCommand(this.options.executable); rpc.start(command.executable, command.args, this.options.cwd);
    const p: InitializeParams = { clientInfo: { name: 'job_finish', title: 'Job-Finish', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta', 'turn/diff/updated'] } };
    await rpc.request('initialize', p); rpc.notify('initialized');
  }
  async run(prompt: string): Promise<void> {
    if (!this.ready || !this.session) throw new Error('Reconnect the Codex session first');
    if (this.starting || this.session.turns.size || this.session.pendingStart) throw new Error('Session has an active or unresolved turn/start request');
    const model = this.options.model || this.effectiveModel;
    if (this.options.mode && !model) throw new Error('Codex did not provide model metadata for the selected mode');
    this.starting = true;
    const rpc = this.rpc!;
    const startRequestId = randomUUID();
    try {
      this.session.beginStart(startRequestId, rpc.connectionId);
      const p: TurnStartParams = { threadId: this.session.binding.sessionId, clientUserMessageId: startRequestId, input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(this.options.mode ? { collaborationMode: { mode: this.options.mode, settings: { model: model!, reasoning_effort: null, developer_instructions: null } } } : {}) };
      const result = await rpc.request<{ turn: Turn }>('turn/start', p);
      if (rpc !== this.rpc || !rpc.connected || !this.session.valid(rpc.connectionId)) throw new Error('Start response connection changed; reconcile the saved request');
      this.session.start(id(result.turn?.id), rpc.connectionId);
      this.adapter!.reconcileTurn(result.turn, rpc.connectionId);
    } catch (e) {
      if (rpc !== this.rpc || !this.session.valid(rpc.connectionId)) this.options.diagnostic.add(e);
      else if (e instanceof RpcError) {
        // Request failure has its own identity, never invent a provider turn ID.
        this.options.diagnostic.add(`turn/start rejected (${e.code}): ${e.message}`);
        this.session.startRejected(startRequestId, e.message, rpc.connectionId);
      } else this.session.disconnected(e);
      throw e;
    } finally { this.starting = false; }
  }
  async cancel(): Promise<void> {
    if (!this.ready || !this.rpc?.connected || !this.session?.valid(this.rpc.connectionId)) throw new Error('No active owned Codex connection');
    const turn = [...this.session?.turns.values() ?? []].find(t => t.status !== 'unknown');
    if (!turn) throw new Error('No confirmed active Codex turn');
    await this.rpc!.request('turn/interrupt', { threadId: this.session!.binding.sessionId, turnId: turn.id });
  }
  respond(requestId: string, result: unknown): void {
    const request = this.session?.requests.get(requestId);
    if (!request || !this.session!.valid(request.connectionId)) throw new Error('Request no longer pending');
    const message = request.payload as RpcMessage;
    this.rpc!.respond(message.id!, result); this.session!.resolve(requestId, request.connectionId);
    this.answered.set(requestId, result);
    this.answeredBytes += Buffer.byteLength(JSON.stringify(result));
    while (this.answered.size > LIMITS.dedup || this.answeredBytes > LIMITS.queueBytes) {
      const oldest = this.answered.keys().next().value!;
      this.answeredBytes -= Buffer.byteLength(JSON.stringify(this.answered.get(oldest))); this.answered.delete(oldest);
    }
  }
  private handle(message: RpcMessage): void {
    if (!this.session?.valid(this.rpc!.connectionId)) return;
    this.options.onEvent?.(message);
    if (message.id !== undefined && message.method && this.answered.has(JSON.stringify(message.id))) {
      this.rpc!.respond(message.id, this.answered.get(JSON.stringify(message.id))); return;
    }
    this.adapter!.handle(message, this.rpc!.connectionId, this.starting);
    if (message.id !== undefined && message.method && !this.session!.requests.has(JSON.stringify(message.id))) {
      this.rpc!.reject(message.id, 'Unsupported or unbound Job-Finish request'); this.options.diagnostic.add(`Unsupported server request: ${message.method}`);
    }
  }
  dispose(): void {
    this.disposed = true;
    try { this.session?.disconnected('Session released'); }
    finally { this.rpc?.dispose(); this.queue.clear(); this.answered.clear(); this.answeredBytes = 0; }
  }
}

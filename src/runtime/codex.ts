import type { InitializeParams } from '../protocol/InitializeParams';
import type { Thread } from '../protocol/v2/Thread';
import type { Turn } from '../protocol/v2/Turn';
import type { ThreadStartParams } from '../protocol/v2/ThreadStartParams';
import type { ThreadResumeParams } from '../protocol/v2/ThreadResumeParams';
import type { TurnStartParams } from '../protocol/v2/TurnStartParams';
import type { PermissionsRequestApprovalParams } from '../protocol/v2/PermissionsRequestApprovalParams';
import type { PermissionsRequestApprovalResponse } from '../protocol/v2/PermissionsRequestApprovalResponse';
import { Session } from '../core/session';
import { inputQuestionText } from '../core/input';
import { Diagnostics, LIMITS, TerminalStatus } from '../core/model';
import { EventQueue, RpcError, RpcMessage, StdioRpc } from './transport';
import { codexCommand } from './executable';
import { randomUUID } from 'node:crypto';
import { CodexHistory } from './codex-history';
import { inputTitle } from './titles';

export function codexStatus(value: string): TerminalStatus | undefined {
  switch (value) { case 'completed': return 'completed'; case 'failed': return 'error'; case 'interrupted': return 'cancelled'; default: return undefined; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Codex object');
  return value as Record<string, unknown>;
}
function id(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Missing Codex identifier'); return value; }

/** Input panels handled by the existing Codex extension, never by Job-Finish's direct execution UI. */
export function observedCodexQuestion(message: RpcMessage): string | undefined {
  const p = object(message.params);
  let input: Record<string, unknown>;
  let tool: string;
  if (message.method === 'item/tool/requestOptionPicker') { input = p; tool = 'request_option_picker'; }
  else {
    if (message.method !== 'item/tool/call' || (p.namespace != null && p.namespace !== 'codex_app')) return;
    if (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) return;
    input = p.arguments as Record<string, unknown>; tool = String(p.tool);
  }
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const optionalText = (value: unknown): boolean => value == null || typeof value === 'string';
  const options = (value: unknown): boolean => Array.isArray(value) && value.every(option =>
    !!option && typeof option === 'object' && !Array.isArray(option) && text((option as Record<string, unknown>).label) &&
      optionalText((option as Record<string, unknown>).description));
  if (tool === 'request_option_picker' && text(input.question) && options(input.options) &&
      (input.allowMultiple === undefined || typeof input.allowMultiple === 'boolean') && optionalText(input.submitLabel) && optionalText(input.skipLabel)) {
    return inputQuestionText([input], 'Codex needs a selection');
  }
  if (tool === 'request_onboarding_input' && Array.isArray(input.questions) && input.questions.length > 0 && input.questions.length <= 3 &&
      input.questions.every(question => !!question && typeof question === 'object' && !Array.isArray(question) &&
        text(question.id) && text(question.question) && optionalText(question.header) &&
        Array.isArray(question.options) && question.options.length >= 2 && options(question.options))) {
    return inputQuestionText(input.questions, 'Codex needs an answer');
  }
  const stringList = (value: unknown, count: number, length: number): boolean => value === undefined ||
    Array.isArray(value) && value.length <= count && value.every(entry => text(entry) && entry.trim().length <= length);
  if (tool === 'request_environment_input' && ['repositories', 'name', 'secrets', 'network', 'review'].includes(String(input.mode)) &&
      (input.reason === undefined || text(input.reason) && input.reason.trim().length <= 512) &&
      stringList(input.domains, 20, 253) && stringList(input.repositories, 10, 512) &&
      (input.secrets === undefined || Array.isArray(input.secrets) && input.secrets.length <= 20 && input.secrets.every(secret =>
        secret && typeof secret === 'object' && !Array.isArray(secret) && text(secret.name) && secret.name.trim().length <= 128))) {
    return text(input.reason) ? input.reason : `Codex needs an environment decision: ${input.mode}`;
  }
  if (tool === 'setup_codex_step' && Object.keys(input).length === 1 && ['role', 'task'].includes(String(input.step))) return `Codex needs a setup selection: ${input.step}`;
}

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
  private statusWaiting = false;
  constructor(readonly session: Session, private statusEpisode = 0) {}
  handle(message: RpcMessage, connectionId: string, admitStarted = false): void {
    if (!this.session.valid(connectionId)) return;
    const methods = ['thread/name/updated', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/status/changed', 'serverRequest/resolved', 'error',
      'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!methods.includes(message.method ?? '')) return;
    const p = object(message.params);
    if (id(p.threadId) !== this.session.binding.sessionId) return;
    if (message.method === 'thread/name/updated') {
      this.session.setTitle(p.threadName, connectionId);
    } else if (message.method === 'turn/started') {
      const turn = object(p.turn);
      if (admitStarted) this.session.start(id(turn.id), connectionId);
      else this.session.running(id(turn.id), connectionId);
    } else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = object(p.item);
      const turnId = id(p.turnId);
      if (item.type === 'userMessage') {
        this.session.turnTitle(turnId, inputTitle(item.content), connectionId);
        this.session.clearInputNotice(turnId, connectionId);
      }
      if (message.method === 'item/completed' && item.type === 'agentMessage') {
        if (item.phase !== 'commentary') {
          if (typeof item.text !== 'string') throw new Error('Malformed agent message');
          this.session.body(turnId, item.text, connectionId);
        }
        if (Array.isArray(item.questions) && item.questions.some(question =>
          question && typeof question === 'object' && typeof question.title === 'string' && question.title.trim())) {
          this.session.notifyWaitingForInput(turnId, connectionId, inputQuestionText(item.questions, 'Codex needs an answer'), `async:${id(item.id)}`, 'question');
        }
      }
    } else if (message.method === 'thread/status/changed') {
      const status = object(p.status);
      const turns = [...this.session.turns.values()];
      if (turns.length !== 1) return; // Thread-level evidence must identify exactly one observed live turn.
      const turn = turns[0]!;
      const flags = status.type === 'active' && Array.isArray(status.activeFlags) ? status.activeFlags : [];
      const kind = flags.includes('waitingOnUserInput') ? 'question' : flags.includes('waitingOnApproval') ? 'approval' : undefined;
      if (this.statusWaiting && !kind) this.statusEpisode++;
      this.statusWaiting = !!kind;
      if (kind) this.session.notifyWaitingForInput(turn.id, connectionId,
        kind === 'question' ? 'Codex needs an answer or selection' : 'Codex needs approval', `status:${turn.id}:${this.statusEpisode}:${kind}`, kind);
      else this.session.clearInputNotice(turn.id, connectionId);
    } else if (message.method === 'turn/completed') {
      this.reconcileTurn(p.turn as Turn, connectionId);
    } else if (message.method === 'serverRequest/resolved') {
      const requestId = JSON.stringify(p.requestId);
      const request = this.session.requests.get(requestId);
      this.session.resolve(requestId, connectionId);
      if (request) this.session.clearInputNotice(request.turnId, connectionId);
    } else if (message.method === 'error') {
      this.session.diagnostics.add(`Codex non-terminal error: ${JSON.stringify(p.error)}`);
    } else if (message.id !== undefined) {
      const turnId = id(p.turnId);
      const question = message.method === 'item/tool/requestUserInput';
      this.session.waiting({ id: JSON.stringify(message.id), turnId, connectionId,
        kind: question ? 'question' : 'approval', payload: message,
        title: question ? inputQuestionText(p.questions, 'Codex needs an answer') : String(p.command ?? p.reason ?? 'Codex needs approval') });
    }
  }
  reconcileTurn(value: Turn, connectionId: string): void {
    const turn = object(value); const turnId = id(turn.id);
    if (Array.isArray(turn.items)) for (const item of turn.items) {
      const entry = object(item);
      if (entry.type === 'userMessage') this.session.turnTitle(turnId, inputTitle(entry.content), connectionId);
    }
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
  private connecting?: Promise<void>;
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryAttempts = 0;
  private answered = new Map<string, unknown>();
  private answeredBytes = 0;
  private reconcilingConflict = false;
  private effectiveModel?: string;
  constructor(private options: CodexOptions) {}
  async open(sessionId?: string): Promise<void> {
    try {
      await this.connect();
      if (sessionId) {
        this.session = this.options.createSession(sessionId, this.rpc!.connectionId);
        this.adapter = new CodexAdapter(this.session);
        const p: ThreadResumeParams = { threadId: sessionId, cwd: this.options.cwd, approvalsReviewer: 'user', excludeTurns: true };
        const result = await this.rpc!.request<{ thread: Thread; model?: string }>('thread/resume', p);
        this.effectiveModel = result.model;
        await this.reconcile(result.thread, this.rpc!);
      } else {
        const p: ThreadStartParams = { cwd: this.options.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: this.options.sandbox ?? 'workspace-write',
          ...(this.options.permissionRequests ? { config: { 'features.request_permissions_tool': true } } : {}), ...(this.options.model ? { model: this.options.model } : {}) };
        const result = await this.rpc!.request<{ thread: Thread; model?: string }>('thread/start', p);
        this.effectiveModel = result.model;
        this.session = this.options.createSession(id(result.thread?.id), this.rpc!.connectionId);
        this.session.setTitle(result.thread.name || result.thread.preview, this.rpc!.connectionId);
        this.adapter = new CodexAdapter(this.session);
      }
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
      this.ready = false; this.queue.clear(); this.session?.disconnected(error); this.options.diagnostic.add(error); this.scheduleRecovery();
    }, message => this.options.diagnostic.add(message));
    this.rpc = rpc;
    const command = codexCommand(this.options.executable); rpc.start(command.executable, command.args, this.options.cwd);
    const p: InitializeParams = { clientInfo: { name: 'job_finish', title: 'Job-Finish', version: '0.1.2' },
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
      this.session.beginStart(startRequestId, rpc.connectionId, prompt);
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
  async reconnect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
    this.connecting = this.recover();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async recover(): Promise<void> {
    if (!this.session || this.disposed) throw new Error('No session to recover');
    if (!this.session.valid(this.session.binding.connectionId)) throw new Error('Session ownership lost');
    this.session.disconnected('Reconnecting; active outcomes require reconciliation'); this.rpc?.dispose();
    try {
      await this.connect(); this.session.reconnect(this.rpc!.connectionId);
      const rpc = this.rpc!;
      const p: ThreadResumeParams = { threadId: this.session.binding.sessionId, cwd: this.options.cwd, approvalsReviewer: 'user', excludeTurns: true };
      const result = await rpc.request<{ thread: Thread; model?: string }>('thread/resume', p);
      this.effectiveModel = result.model;
      await this.reconcile(result.thread, rpc); this.ready = true; this.queue.drain(message => this.handle(message));
    } catch (error) { this.rpc?.dispose(); this.queue.clear(); this.session.disconnected(error); throw error; }
  }
  private scheduleRecovery(): void {
    if (!this.session || this.disposed || this.recoveryTimer || this.recoveryAttempts >= 3) return;
    const delay = 1000 * 2 ** this.recoveryAttempts++;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.reconnect().catch(error => { this.options.diagnostic.add(error); this.scheduleRecovery(); });
    }, delay);
  }
  private history(rpc: StdioRpc): CodexHistory {
    return new CodexHistory(rpc, this.session!.binding.sessionId, () => {
      if (this.disposed || rpc !== this.rpc || !rpc.connected || !this.session!.valid(rpc.connectionId)) throw new Error('History lookup connection or ownership changed');
    });
  }
  private async reconcile(thread: Thread, rpc: StdioRpc): Promise<void> {
    if (id(thread?.id) !== this.session!.binding.sessionId) throw new Error('Invalid thread recovery response');
    this.session!.setTitle(thread.name || thread.preview, rpc.connectionId);
    const history = this.history(rpc); const { turns, truncated } = await history.turns();
    if (truncated) this.options.diagnostic.add('History baseline limited to the latest 512 turns; older unobserved turns cannot notify');
    const pending = this.session!.pendingStart;
    if (pending) {
      for (const turn of turns) if (await history.matchesStart(turn.id, pending)) { history.assertCurrent(); this.session!.start(turn.id, rpc.connectionId); break; }
    }
    history.assertCurrent();
    if (turns.some(turn => turn.status === 'inProgress' && !this.session!.turns.has(turn.id)) ||
        (thread.status?.type === 'active' && !turns.some(turn => turn.status === 'inProgress'))) throw new Error('Cannot establish ownership of an unobserved active execution');
    for (const turn of turns) {
      if (turn.status === 'inProgress' && thread.status?.type !== 'active') {
        this.session!.disconnected('Stored turn is incomplete but the resumed runtime does not confirm an active execution'); continue;
      }
      if (this.session!.turns.has(turn.id) && codexStatus(turn.status)) {
        const text = await history.finalText(turn.id); history.assertCurrent(); if (text !== undefined) this.session!.body(turn.id, text, rpc.connectionId);
      }
      this.adapter!.reconcileTurn(turn, rpc.connectionId);
    }
    history.assertCurrent(); this.session!.baseline([...turns].reverse().flatMap(turn => { const status = codexStatus(turn.status); return status ? [{ id: turn.id, status }] : []; }));
  }
  private handle(message: RpcMessage): void {
    if (!this.session?.valid(this.rpc!.connectionId)) return;
    this.options.onEvent?.(message);
    if (message.id !== undefined && message.method && this.answered.has(JSON.stringify(message.id))) {
      this.rpc!.respond(message.id, this.answered.get(JSON.stringify(message.id))); return;
    }
    if (message.method === 'turn/completed') {
      const p = object(message.params); const turn = object(p.turn);
      const previous = this.session!.completed.get(String(turn.id));
      if (p.threadId === this.session!.binding.sessionId && previous && codexStatus(String(turn.status)) !== previous && !this.reconcilingConflict) {
        this.reconcilingConflict = true;
        // Read-only reconciliation does not create a turn or redeliver a conflicting result.
        const rpc = this.rpc!;
        void rpc.request<{ thread: Thread }>('thread/read', { threadId: p.threadId, includeTurns: false })
          .then(result => this.reconcile(result.thread, rpc)).catch(error => this.options.diagnostic.add(error)).finally(() => { this.reconcilingConflict = false; });
      }
    }
    this.adapter!.handle(message, this.rpc!.connectionId, this.starting);
    if (message.id !== undefined && message.method && !this.session!.requests.has(JSON.stringify(message.id))) {
      this.rpc!.reject(message.id, 'Unsupported or unbound Job-Finish request'); this.options.diagnostic.add(`Unsupported server request: ${message.method}`);
    }
  }
  async readResult(turnId: string): Promise<string | undefined> {
    if (!this.ready) return undefined;
    const history = this.history(this.rpc!); const text = await history.finalText(turnId); history.assertCurrent(); return text;
  }
  dispose(): void {
    this.disposed = true; if (this.recoveryTimer) clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
    try { this.session?.disconnected('Session released'); }
    finally { this.rpc?.dispose(); this.queue.clear(); this.answered.clear(); this.answeredBytes = 0; }
  }
}

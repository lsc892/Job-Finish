import type { InitializeParams } from '../../protocol/InitializeParams';
import { Diagnostics, LIMITS } from '../../core/model';
import { EventQueue, RpcMessage, StdioRpc } from '../transport';
import { codexCommand } from './executable';

export interface CodexConnectionOptions { cwd: string; executable?: string; diagnostic: Diagnostics }
interface ConnectionEvents {
  message(message: RpcMessage): void;
  disconnected(reason: unknown): void;
  recover(): Promise<void>;
  canRecover(): boolean;
}

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BASE_DELAY_MS = 1000;

/** Owns the transport, readiness queue and response cache for each connection generation. */
export class CodexConnection {
  private transport?: StdioRpc;
  private readonly queue = new EventQueue();
  private readyState = false;
  private disposedState = false;
  private connecting?: Promise<void>;
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryAttempts = 0;
  private readonly answered = new Map<string, unknown>();
  private answeredBytes = 0;

  constructor(private readonly options: CodexConnectionOptions, private readonly events: ConnectionEvents) {}

  get rpc(): StdioRpc | undefined { return this.transport; }
  get ready(): boolean { return this.readyState; }
  get disposed(): boolean { return this.disposedState; }
  isCurrent(rpc: StdioRpc): boolean { return !this.disposedState && rpc === this.transport; }

  async open(): Promise<void> {
    this.readyState = false;
    this.queue.clear();
    this.clearAnswers();
    const rpc = new StdioRpc(message => {
      if (!this.isCurrent(rpc)) return;
      if (this.readyState) this.events.message(message);
      else this.queue.push(message);
    }, error => {
      if (!this.isCurrent(rpc)) return;
      this.readyState = false;
      this.queue.clear();
      this.events.disconnected(error);
      this.options.diagnostic.add(error);
      this.scheduleRecovery();
    }, message => this.options.diagnostic.add(message));
    this.transport = rpc;
    const command = codexCommand(this.options.executable);
    rpc.start(command.executable, command.args, this.options.cwd);
    const params: InitializeParams = {
      clientInfo: { name: 'job_finish', title: 'Job-Finish', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [
        'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
        'item/commandExecution/outputDelta', 'turn/diff/updated',
      ] },
    };
    await rpc.request('initialize', params);
    rpc.notify('initialized');
  }

  activate(): void {
    this.readyState = true;
    this.queue.drain(message => this.events.message(message));
  }

  close(): void {
    this.transport?.dispose();
    this.queue.clear();
  }

  async reconnect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.clearRecoveryTimer();
    this.connecting = this.events.recover();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private scheduleRecovery(): void {
    if (!this.events.canRecover() || this.disposedState || this.recoveryTimer || this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) return;
    const delay = RECOVERY_BASE_DELAY_MS * 2 ** this.recoveryAttempts++;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.reconnect().catch(error => {
        this.options.diagnostic.add(error);
        this.scheduleRecovery();
      });
    }, delay);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  replayAnswer(message: RpcMessage): boolean {
    if (message.id === undefined || !message.method) return false;
    const requestId = JSON.stringify(message.id);
    if (!this.answered.has(requestId)) return false;
    this.transport!.respond(message.id, this.answered.get(requestId));
    return true;
  }

  rememberAnswer(requestId: string, result: unknown): void {
    this.answered.set(requestId, result);
    this.answeredBytes += Buffer.byteLength(JSON.stringify(result));
    while (this.answered.size > LIMITS.dedup || this.answeredBytes > LIMITS.queueBytes) {
      const oldest = this.answered.keys().next().value!;
      this.answeredBytes -= Buffer.byteLength(JSON.stringify(this.answered.get(oldest)));
      this.answered.delete(oldest);
    }
  }

  private clearAnswers(): void {
    this.answered.clear();
    this.answeredBytes = 0;
  }

  dispose(): void {
    this.disposedState = true;
    this.clearRecoveryTimer();
    try {
      this.events.disconnected('Session released');
    } finally {
      this.close();
      this.clearAnswers();
    }
  }
}

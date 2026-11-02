// Codex RPC 연결의 초기화·대기 이벤트·응답 캐시·재연결을 관리한다.
import type { InitializeParams } from '../../protocol/InitializeParams';
import { Diagnostics, LIMITS } from '../../core/model';
import { EventQueue, RpcMessage, StdioRpc } from '../transport';
import { codexCommand } from './executable';

export interface CodexConnectionOptions {
  cwd: string;
  executable?: string;
  diagnostic: Diagnostics;
}
interface ConnectionEvents {
  message(message: RpcMessage): void;
  disconnected(reason: unknown): void;
  recover(): Promise<void>;
  canRecover(): boolean;
}

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BASE_DELAY_MS = 1000;

/** 연결 세대별 RPC 초기화·이벤트 대기·응답 캐시·복구 재시도를 관리한다. */
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
    // RPC 인스턴스를 캡처해 이전 연결에서 늦게 도착한 이벤트를 제외한다.
    const rpc = new StdioRpc(
      message => this.handleRpcMessage(rpc, message),
      error => this.handleRpcDisconnect(rpc, error),
      this.options.diagnostic.add.bind(this.options.diagnostic),
    );
    this.transport = rpc;
    const command = codexCommand(this.options.executable);
    rpc.start(command.executable, command.args, this.options.cwd);
    const params: InitializeParams = {
      clientInfo: { name: 'job_finish', title: 'Job-Finish', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
          'item/commandExecution/outputDelta', 'turn/diff/updated',
        ],
      },
    };
    await rpc.request('initialize', params);
    rpc.notify('initialized');
  }

  private handleRpcMessage(rpc: StdioRpc, message: RpcMessage): void {
    if (!this.isCurrent(rpc)) return;
    if (this.readyState) this.events.message(message);
    else this.queue.push(message);
  }

  private handleRpcDisconnect(rpc: StdioRpc, error: Error): void {
    if (!this.isCurrent(rpc)) return;
    this.readyState = false;
    this.queue.clear();
    this.events.disconnected(error);
    this.options.diagnostic.add(error);
    this.scheduleRecovery();
  }

  activate(): void {
    this.readyState = true;
    this.queue.drain(this.events.message.bind(this.events));
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

  // 연결 복구는 1초·2초·4초 간격으로 최대 세 번 예약한다.
  private scheduleRecovery(): void {
    if (!this.events.canRecover() || this.disposedState || this.recoveryTimer) return;
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) return;
    const delay = RECOVERY_BASE_DELAY_MS * 2 ** this.recoveryAttempts++;
    this.recoveryTimer = setTimeout(this.handleRecoveryTimeout.bind(this), delay);
  }

  private handleRecoveryTimeout(): void {
    this.recoveryTimer = undefined;
    void this.reconnect().catch(error => {
      this.options.diagnostic.add(error);
      this.scheduleRecovery();
    });
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
    // 응답을 삽입한 순서대로 제거해 개수와 직렬화 바이트 상한을 함께 지킨다.
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

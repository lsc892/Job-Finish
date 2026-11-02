// 관리하는 자식 프로세스와 RPC 메시지를 교환하고 연결 수명을 관리한다.
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../../core/model';
import { JsonLines } from './json-lines';
import type { RpcId, RpcMessage } from './message';
import { PendingRequests } from './pending-requests';

const PROCESS_SHUTDOWN_GRACE_MS = 1500;

/** 관리하는 자식 프로세스와 RPC 요청·응답·알림 및 연결 종료를 처리한다. */
export class StdioRpc {
  readonly connectionId = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private readonly requests: PendingRequests;
  private closed = false;
  private readonly decoder: JsonLines;
  get connected(): boolean { return !!this.child && !this.closed; }

  constructor(private readonly receive: (message: RpcMessage) => void, private readonly disconnected: (error: Error) => void,
    private readonly diagnostic: (message: string) => void) {
    this.decoder = new JsonLines(this.dispatch.bind(this));
    this.requests = new PendingRequests(this.write.bind(this), this.fail.bind(this), this.diagnostic.bind(this));
  }

  start(executable: string, args: string[], cwd: string): void {
    if (this.child) throw new Error('Connection already started');
    this.child = spawn(executable, args, {
      cwd, windowsHide: true, shell: false, stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JOB_FINISH_OWNED_EXECUTION: '1' },
    });
    this.attachProcessEvents(this.child);
  }

  // 자식 프로세스의 출력 도착·스트림 종료·오류 이벤트에 처리기를 등록한다.
  private attachProcessEvents(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on('data', this.handleStdoutData.bind(this));
    child.stdout.on('end', this.handleStdoutEnd.bind(this));
    child.stderr.on('data', this.handleStderrData.bind(this));
    child.on('error', this.fail.bind(this));
    child.stdin.on('error', this.fail.bind(this));
    child.on('exit', this.handleProcessExit.bind(this));
  }

  private handleStdoutData(chunk: Buffer): void {
    try { this.decoder.push(chunk); }
    catch (error) { this.fail(error); }
  }

  private handleStdoutEnd(): void {
    try { this.decoder.end(); }
    catch (error) { this.fail(error); }
    this.fail(new Error('App Server EOF'));
  }

  private handleStderrData(chunk: Buffer): void {
    this.diagnostic(chunk.toString('utf8'));
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.fail(new Error(`App Server exited (${code ?? signal})`));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    return this.requests.request<T>(method, params);
  }

  notify(method: string, params?: unknown): void { this.write({ method, params }); }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  reject(id: RpcId, message: string): void { this.write({ id, error: { code: -32601, message } }); }

  private write(message: RpcMessage): void {
    if (this.closed || !this.child) throw new Error('Connection closed');
    const data = JSON.stringify(message) + '\n';
    const bytes = Buffer.byteLength(data);
    if (bytes > LIMITS.messageBytes || this.child.stdin.writableLength + bytes > LIMITS.queueBytes) {
      throw new Error('RPC outgoing buffer overflow');
    }
    this.child.stdin.write(data);
  }

  private dispatch(message: RpcMessage): void {
    if (this.closed) return;
    if (message.method) { this.receive(message); return; }
    this.requests.completeResponse(message);
  }

  private fail(value: unknown): void {
    if (this.closed) return;
    const error = value instanceof Error ? value : new Error(String(value));
    this.dispose();
    try { this.disconnected(error); } catch (failure) { this.diagnostic(`Disconnect cleanup failed: ${String(failure)}`); }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.decoder.clear();
    this.requests.rejectAll();
    this.closeOwnedProcess();
  }

  private closeOwnedProcess(): void {
    const child = this.child;
    if (!child) return;
    child.stdin.end(); // Give the owned App Server time to close its SDK/MCP children on EOF.
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.scheduleForcedShutdown(child);
  }

  private scheduleForcedShutdown(child: ChildProcessWithoutNullStreams): void {
    const force = setTimeout(child.kill.bind(child), PROCESS_SHUTDOWN_GRACE_MS);
    force.unref();
    child.once('exit', clearTimeout.bind(undefined, force));
  }
}

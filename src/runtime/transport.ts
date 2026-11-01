// 관리하는 자식 프로세스와 용량이 제한된 JSON Lines RPC 통신을 제공한다.
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../core/model';

const INITIAL_MESSAGE_CAPACITY_BYTES = 4096;
const RPC_TIMEOUT_MS = 30_000;
const PROCESS_SHUTDOWN_GRACE_MS = 1500;

export type RpcId = string | number;
export interface RpcMessage { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
/** RPC 응답의 오류 코드와 메시지를 호출자에게 전달한다. */
export class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
/** 수신 바이트를 크기가 제한된 JSON Lines 메시지로 나누고 RPC 형식을 검증한다. */
export class JsonLines {
  private partial = Buffer.alloc(0);
  private length = 0;
  constructor(private readonly receive: (message: RpcMessage) => void, private readonly limit = LIMITS.messageBytes) {}
  push(chunk: Buffer): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      this.append(chunk.subarray(start, i));
      if (this.length) this.receive(this.decodeMessage());
      start = i + 1;
    }
    this.append(chunk.subarray(start));
  }
  private decodeMessage(): RpcMessage {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(this.partial.subarray(0, this.length));
    this.length = 0;
    const message: unknown = JSON.parse(text);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid JSON-RPC message');
    const rpc = message as RpcMessage;
    const validId = typeof rpc.id === 'string' || (typeof rpc.id === 'number' && Number.isFinite(rpc.id));
    if (rpc.id !== undefined && !validId) throw new Error('Invalid JSON-RPC identifier');
    if ('method' in rpc) {
      if (typeof rpc.method !== 'string' || !rpc.method || 'result' in rpc || 'error' in rpc) throw new Error('Invalid JSON-RPC request/notification');
    } else {
      const hasResult = 'result' in rpc;
      const hasError = 'error' in rpc;
      if (rpc.id === undefined || hasResult === hasError) throw new Error('Invalid JSON-RPC response');
    }
    return rpc;
  }
  private append(chunk: Buffer): void {
    const required = this.length + chunk.length;
    if (required > this.limit) throw new Error('JSON-RPC message exceeds 1 MiB limit');
    if (required > this.partial.length) {
      const next = Buffer.allocUnsafe(Math.min(this.limit, Math.max(required, INITIAL_MESSAGE_CAPACITY_BYTES, this.partial.length * 2)));
      this.partial.copy(next, 0, 0, this.length); this.partial = next;
    }
    chunk.copy(this.partial, this.length); this.length = required;
  }
  end(): void { if (this.length) throw new Error('EOF in JSON-RPC message'); }
  clear(): void { this.partial = Buffer.alloc(0); this.length = 0; }
  get bufferedBytes(): number { return this.length; }
}
/** 개수·바이트 상한 안에서 초기화 전 RPC 이벤트를 보관하고 순서대로 전달한다. */
export class EventQueue {
  private items: RpcMessage[] = [];
  private bytes = 0;
  push(message: RpcMessage): void {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.items.length >= LIMITS.queueCount || this.bytes + bytes > LIMITS.queueBytes) throw new Error('Event queue overflow; reconciliation required');
    this.items.push(message); this.bytes += bytes;
  }
  drain(handle: (message: RpcMessage) => void): void {
    const items = this.items;
    this.clear();
    for (const message of items) handle(message);
  }
  clear(): void { this.items = []; this.bytes = 0; }
  get size(): number { return this.items.length; }
}

/** 관리하는 자식 프로세스와 RPC 요청·응답·알림 및 연결 종료를 처리한다. */
export class StdioRpc {
  readonly connectionId = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private decoder: JsonLines;
  get connected(): boolean { return !!this.child && !this.closed; }
  constructor(private receive: (message: RpcMessage) => void, private disconnected: (error: Error) => void, private diagnostic: (message: string) => void) {
    this.decoder = new JsonLines(message => this.dispatch(message));
  }
  start(executable: string, args: string[], cwd: string): void {
    if (this.child) throw new Error('Connection already started');
    this.child = spawn(executable, args, { cwd, windowsHide: true, shell: false, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JOB_FINISH_OWNED_EXECUTION: '1' } });
    this.child.stdout.on('data', (chunk: Buffer) => { try { this.decoder.push(chunk); } catch (e) { this.fail(e); } });
    this.child.stdout.on('end', () => { try { this.decoder.end(); } catch (e) { this.fail(e); } this.fail(new Error('App Server EOF')); });
    this.child.stderr.on('data', (chunk: Buffer) => this.diagnostic(chunk.toString('utf8')));
    this.child.on('error', e => this.fail(e));
    this.child.stdin.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => this.fail(new Error(`App Server exited (${code ?? signal})`)));
  }
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    if (this.pending.size >= LIMITS.requests) return Promise.reject(new Error('RPC pending request limit exceeded'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`RPC timeout: ${method}; outcome unknown`);
        reject(error);
        this.fail(error);
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.write({ id, method, params }); } catch (e) { this.fail(e); }
    });
  }
  notify(method: string, params?: unknown): void { this.write({ method, params }); }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }); }
  reject(id: RpcId, message: string): void { this.write({ id, error: { code: -32601, message } }); }
  private write(message: RpcMessage): void {
    if (this.closed || !this.child) throw new Error('Connection closed');
    const data = JSON.stringify(message) + '\n';
    const bytes = Buffer.byteLength(data);
    if (bytes > LIMITS.messageBytes || this.child.stdin.writableLength + bytes > LIMITS.queueBytes) throw new Error('RPC outgoing buffer overflow');
    this.child.stdin.write(data);
  }
  private dispatch(message: RpcMessage): void {
    if (this.closed) return;
    if (message.method) { this.receive(message); return; }
    if (message.id === undefined) throw new Error('RPC response has no request id');
    const pending = this.pending.get(message.id);
    if (!pending) { this.diagnostic('Response to unknown RPC request'); return; }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new RpcError(message.error.code, message.error.message));
      return;
    }
    if ('result' in message) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error('Malformed RPC response'));
    throw new Error('Malformed RPC response');
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
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed; outcome unknown'));
    }
    this.pending.clear();
    this.closeOwnedProcess();
  }
  private closeOwnedProcess(): void {
    const child = this.child;
    if (!child) return;
    child.stdin.end(); // Give the owned App Server time to close its SDK/MCP children on EOF.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const force = setTimeout(() => child.kill(), PROCESS_SHUTDOWN_GRACE_MS);
    force.unref();
    child.once('exit', () => clearTimeout(force));
  }
}

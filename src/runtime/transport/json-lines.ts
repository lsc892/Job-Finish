// 수신 바이트를 크기가 제한된 JSON Lines RPC 메시지로 해석한다.
import { LIMITS } from '../../core/model';
import type { RpcMessage } from './message';

const INITIAL_MESSAGE_CAPACITY_BYTES = 4096;

/** 수신 바이트를 줄바꿈마다 JSON 메시지로 나누고 RPC 형식과 크기를 검증한다. */
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
    return this.validateMessage(JSON.parse(text));
  }

  private validateMessage(message: unknown): RpcMessage {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid JSON-RPC message');
    const rpc = message as RpcMessage;
    this.validateIdentifier(rpc);
    if ('method' in rpc) this.validateRequest(rpc);
    else this.validateResponse(rpc);
    return rpc;
  }

  private validateIdentifier(rpc: RpcMessage): void {
    const validId = typeof rpc.id === 'string' || (typeof rpc.id === 'number' && Number.isFinite(rpc.id));
    if (rpc.id !== undefined && !validId) throw new Error('Invalid JSON-RPC identifier');
  }

  private validateRequest(rpc: RpcMessage): void {
    if (typeof rpc.method !== 'string' || !rpc.method || 'result' in rpc || 'error' in rpc) {
      throw new Error('Invalid JSON-RPC request/notification');
    }
  }

  private validateResponse(rpc: RpcMessage): void {
    const hasResult = 'result' in rpc;
    const hasError = 'error' in rpc;
    if (rpc.id === undefined || hasResult === hasError) throw new Error('Invalid JSON-RPC response');
  }

  private append(chunk: Buffer): void {
    const required = this.length + chunk.length;
    if (required > this.limit) throw new Error('JSON-RPC message exceeds 1 MiB limit');
    this.ensureCapacity(required);
    chunk.copy(this.partial, this.length);
    this.length = required;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.partial.length) return;
    const capacity = Math.min(this.limit, Math.max(required, INITIAL_MESSAGE_CAPACITY_BYTES, this.partial.length * 2));
    const next = Buffer.allocUnsafe(capacity);
    this.partial.copy(next, 0, 0, this.length);
    this.partial = next;
  }

  end(): void { if (this.length) throw new Error('EOF in JSON-RPC message'); }
  clear(): void {
    this.partial = Buffer.alloc(0);
    this.length = 0;
  }
  get bufferedBytes(): number { return this.length; }
}

// RPC 대기 요청의 개수·만료 시간과 응답 매칭·일괄 거절을 관리한다.
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../../core/model';
import { RpcError, RpcId, RpcMessage } from './message';

const RPC_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** 요청별 Promise와 타이머를 소유하고 전송·연결 실패 처리는 콜백에 위임한다. */
export class PendingRequests {
  private readonly pending = new Map<RpcId, PendingRequest>();

  constructor(private readonly send: (message: RpcMessage) => void, private readonly fail: (error: unknown) => void,
    private readonly diagnostic: (message: string) => void) {}

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.pending.size >= LIMITS.requests) return Promise.reject(new Error('RPC pending request limit exceeded'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.registerRequest(id, method, value => resolve(value as T), reject);
      this.sendRequest({ id, method, params });
    });
  }

  private registerRequest(id: RpcId, method: string, resolve: (value: unknown) => void, reject: (error: Error) => void): void {
    const timer = setTimeout(this.timeoutRequest.bind(this, id, method, reject), RPC_TIMEOUT_MS);
    this.pending.set(id, { resolve, reject, timer });
  }

  private timeoutRequest(id: RpcId, method: string, reject: (error: Error) => void): void {
    this.pending.delete(id);
    const error = new Error(`RPC timeout: ${method}; outcome unknown`);
    reject(error);
    this.fail(error);
  }

  private sendRequest(message: RpcMessage): void {
    try { this.send(message); }
    catch (error) { this.fail(error); }
  }

  completeResponse(message: RpcMessage): void {
    if (message.id === undefined) throw new Error('RPC response has no request id');
    const pending = this.pending.get(message.id);
    if (!pending) { this.diagnostic('Response to unknown RPC request'); return; }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    this.settleResponse(pending, message);
  }

  private settleResponse(pending: PendingRequest, message: RpcMessage): void {
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

  rejectAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed; outcome unknown'));
    }
    this.pending.clear();
  }
}

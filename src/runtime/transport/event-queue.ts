// 초기화가 끝날 때까지 RPC 이벤트를 용량 상한 안에서 보관한다.
import { LIMITS } from '../../core/model';
import type { RpcMessage } from './message';

/** 개수·바이트 상한 안에서 초기화 전 RPC 이벤트를 보관하고 순서대로 전달한다. */
export class EventQueue {
  private items: RpcMessage[] = [];
  private bytes = 0;

  push(message: RpcMessage): void {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.items.length >= LIMITS.queueCount || this.bytes + bytes > LIMITS.queueBytes) {
      throw new Error('Event queue overflow; reconciliation required');
    }
    this.items.push(message);
    this.bytes += bytes;
  }

  drain(handle: (message: RpcMessage) => void): void {
    const items = this.items;
    this.clear();
    for (const message of items) handle(message);
  }
  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
  get size(): number { return this.items.length; }
}

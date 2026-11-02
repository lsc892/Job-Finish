// 관찰 연결 하나의 스트림 구독·JSONL 해석·원래 write 복원과 정리를 관리한다.
import { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { Diagnostics, LIMITS, Provider, Signal } from '../core/model';
import type { AgentProviderRegistry } from './agent-provider';
import { AgentEventRouter } from './event-router';

interface ObservationOptions {
  provider: Provider;
  windowInstanceId: string;
  existing: boolean;
  diagnostics: Diagnostics;
  providers: AgentProviderRegistry;
  emit(signal: Signal): void;
  isOwned(provider: Provider, sessionId: string): boolean;
  closed(): void;
}

/** 줄바꿈까지 수신 바이트를 모아 UTF-8 JSON 메시지로 전달한다. */
class Frames {
  private buffer = Buffer.alloc(0);
  private length = 0;
  private first = true;
  constructor(private receive: (value: unknown) => void, private allowPartialStart: boolean) {}

  // 청크에 나뉜 메시지를 버퍼에 모아 줄바꿈마다 완성된 프레임을 처리한다.
  push(chunk: Buffer): void {
    let start = 0;
    for (let at = 0; at < chunk.length; at++) {
      if (chunk[at] !== 10) continue;
      this.append(chunk.subarray(start, at));
      start = at + 1;
      this.receiveFrame();
    }
    this.append(chunk.subarray(start));
  }

  private receiveFrame(): void {
    if (!this.length) return;
    let value: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.length));
      value = JSON.parse(text);
    } catch (error) {
      if (!this.first || !this.allowPartialStart) throw error;
    }
    this.first = false;
    this.length = 0;
    if (value !== undefined) this.receive(value);
  }

  // 버퍼는 두 배 확장을 기준으로 늘리되 프레임 하나는 1 MiB로 제한한다.
  private append(chunk: Buffer): void {
    const length = this.length + chunk.length;
    if (length > LIMITS.messageBytes) throw new Error('Observed stream frame exceeds 1 MiB');
    if (length > this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.min(LIMITS.messageBytes, Math.max(4096, length, this.buffer.length * 2)));
      this.buffer.copy(next, 0, 0, this.length);
      this.buffer = next;
    }
    chunk.copy(this.buffer, this.length);
    this.length = length;
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
    this.length = 0;
  }
  get capacity(): number { return this.buffer.length; }
}

/** 한 자식 프로세스의 수신·송신 관찰과 구독 해제를 소유한다. */
export class ObservedConnection {
  readonly router: AgentEventRouter;
  private readonly input: Writable;
  private readonly output: Readable;
  private readonly incoming: Frames;
  private readonly outgoing: Frames;
  private readonly originalWrite: Writable['write'];
  private readonly observedWrite: Writable['write'];
  private disposed = false;

  constructor(private child: ChildProcess, private options: ObservationOptions) {
    this.input = child.stdin!;
    this.output = child.stdout!;
    this.router = new AgentEventRouter(options.provider, options.windowInstanceId,
      `${options.provider}:extension-host:${process.pid}:${child.pid}`,
      options.emit, options.diagnostics, options.isOwned, options.providers);
    this.incoming = new Frames(this.router.incoming.bind(this.router), options.existing);
    this.outgoing = new Frames(this.router.outgoing.bind(this.router), options.existing);
    this.originalWrite = this.input.write;
    this.observedWrite = this.createObservedWrite();

    // 등록과 해제에 같은 함수 객체를 사용한다.
    this.handleStdoutData = this.handleStdoutData.bind(this);
    this.dispose = this.dispose.bind(this);
  }

  // 데이터 도착·스트림 종료 콜백을 등록하고 stdin 쓰기를 관찰한다.
  start(): void {
    this.input.write = this.observedWrite;
    this.output.on('data', this.handleStdoutData);
    // exit 이후에도 마지막 stdout이 남을 수 있으므로 스트림 종료까지 관찰한다.
    this.output.once('end', this.dispose);
    this.child.once('close', this.dispose);
  }

  // 비동기로 도착한 출력 바이트를 수신 콜백 안에서 동기적으로 파싱한다.
  private handleStdoutData(chunk: Buffer | string): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.incoming.push(bytes);
    } catch (error) {
      this.handleObservationFailure(error);
    }
  }

  private createObservedWrite(): Writable['write'] {
    const connection = this;
    return function observeStdinWrite(this: Writable, ...args: unknown[]): boolean {
      // 원래 receiver·인자·반환값을 유지하고 write 호출이 반환된 뒤에 관찰한다.
      const result = Reflect.apply(connection.originalWrite, this, args) as boolean;
      connection.handleStdinWrite(args);
      return result;
    } as Writable['write'];
  }

  private handleStdinWrite(args: unknown[]): void {
    if (this.disposed) return;
    try {
      const chunk = args[0];
      const encoding = typeof args[1] === 'string' ? args[1] as BufferEncoding : 'utf8';
      if (typeof chunk === 'string') this.outgoing.push(Buffer.from(chunk, encoding));
      else if (chunk instanceof Uint8Array) this.outgoing.push(Buffer.from(chunk));
    } catch (error) {
      this.handleObservationFailure(error);
    }
  }

  private handleObservationFailure(error: unknown): void {
    this.options.diagnostics.add(`Observed ${this.options.provider} connection stopped: ${error}`);
    this.dispose();
  }

  get bufferBytes(): number { return this.incoming.capacity + this.outgoing.capacity; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.output.removeListener('data', this.handleStdoutData);
    this.output.removeListener('end', this.dispose);
    this.child.removeListener('close', this.dispose);
    if (this.input.write === this.observedWrite) this.input.write = this.originalWrite;
    this.incoming.clear();
    this.outgoing.clear();
    this.router.dispose();
    this.options.closed();
  }
}

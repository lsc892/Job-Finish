// 관찰 연결 하나의 스트림 구독·JSONL 해석·원래 write 복원과 정리를 관리한다.
import { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { Diagnostics, Provider, Signal } from '../core/model';
import { AgentEventRouter } from './event-router';
import { Frames, FrameReduction } from './frames';

interface ObservationOptions {
  provider: Provider;
  windowInstanceId: string;
  existing: boolean;
  diagnostics: Diagnostics;
  emit(signal: Signal): void;
  closed(): void;
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
      options.emit, options.diagnostics);
    this.incoming = new Frames(this.router.incoming.bind(this.router), options.existing, reduction => this.frameReduced('incoming', reduction));
    this.outgoing = new Frames(this.router.outgoing.bind(this.router), options.existing, reduction => this.frameReduced('outgoing', reduction));
    this.originalWrite = this.input.write;
    const connection = this;
    this.observedWrite = function observeStdinWrite(this: Writable, ...args: unknown[]): boolean {
      // 원래 receiver·인자·반환값을 유지하고 write 호출이 반환된 뒤에 관찰한다.
      const result = Reflect.apply(connection.originalWrite, this, args) as boolean;
      if (connection.disposed) return result;
      try {
        const chunk = args[0];
        const encoding = typeof args[1] === 'string' ? args[1] as BufferEncoding : 'utf8';
        if (typeof chunk === 'string') connection.outgoing.push(Buffer.from(chunk, encoding));
        else if (chunk instanceof Uint8Array) connection.outgoing.push(Buffer.from(chunk));
      } catch (error) {
        connection.handleObservationFailure(error);
      }
      return result;
    } as Writable['write'];

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
    this.options.diagnostics.trace('observer.connection.attached', { windowInstanceId: this.options.windowInstanceId,
      provider: this.options.provider, connectionId: this.router.connectionId, pid: this.child.pid, existing: this.options.existing });
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

  private handleObservationFailure(error: unknown): void {
    this.options.diagnostics.add(`Observed ${this.options.provider} connection stopped: ${error}`, { stage: 'stream-observation', provider: this.options.provider,
      connectionId: this.router.connectionId, windowInstanceId: this.options.windowInstanceId });
    this.dispose();
  }

  private frameReduced(direction: string, reduction: FrameReduction): void {
    this.options.diagnostics.trace(reduction.skipped ? 'observer.frame.skipped' : 'observer.frame.truncated', {
      windowInstanceId: this.options.windowInstanceId, provider: this.options.provider,
      connectionId: this.router.connectionId, direction, ...reduction });
  }

  get bufferBytes(): number { return this.incoming.capacity + this.outgoing.capacity; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.diagnostics.trace('observer.connection.detached', { windowInstanceId: this.options.windowInstanceId,
      pid: this.child.pid,
      exitCode: this.child.exitCode, signalCode: this.child.signalCode, ...this.router.snapshot() });
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

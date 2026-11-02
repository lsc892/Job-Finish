// 네이티브 토스트 도우미 프로세스의 입출력·시간 제한·종료를 관리한다.
import { ChildProcess, spawn } from 'node:child_process';
import { Diagnostics } from '../../core/model';

export interface ToastProcessPorts {
  launch(binary: string, args: string[]): ChildProcess;
}

export interface ToastProcessRun {
  readonly pid: number | undefined;
  readonly completion: Promise<void>;
  cancel(): void;
}

const processes: ToastProcessPorts = {
  launch: (binary, args) => spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
};
const HELPER_TIMEOUT_MS = 15_000;
const MAX_STDERR_CHARACTERS = 8192;
const MAX_DIAGNOSTIC_BYTES = 32768;

interface HelperState {
  child: ChildProcess;
  args: string[];
  input: unknown;
  receive(event: Record<string, unknown>): void;
  resolve(): void;
  reject(error: unknown): void;
  timer?: NodeJS.Timeout;
  stderr: string;
  stdoutBuffer: string;
  diagnosticBytes: number;
  error?: Error;
}

/** 등록·전달 도우미의 입출력·시간 제한을 처리하고 스트림 종료까지 프로세스를 관리한다. */
export class ToastProcessRunner {
  private readonly children = new Set<ChildProcess>();

  constructor(private binary: string, private diagnostics: Diagnostics, private ports: ToastProcessPorts = processes) {}

  run(
    args: string[],
    input: unknown,
    receive: (event: Record<string, unknown>) => void,
    started?: (run: ToastProcessRun) => void
  ): ToastProcessRun {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    let child: ChildProcess | undefined;
    const run: ToastProcessRun = {
      get pid() { return child?.pid; },
      completion,
      cancel() { child?.kill(); }
    };

    try {
      child = this.ports.launch(this.binary, args);
      this.children.add(child);
      const state: HelperState = {
        child, args, input, receive, resolve, reject,
        stderr: '', stdoutBuffer: '', diagnosticBytes: 0
      };
      state.timer = setTimeout(() => {
        this.failHelper(state, new Error('Native toast helper timed out'));
        state.reject(state.error);
      }, HELPER_TIMEOUT_MS);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => {
        state.stderr = (state.stderr + String(chunk)).slice(0, MAX_STDERR_CHARACTERS);
      });
      child.stdout?.on('data', this.handleStdoutData.bind(this, state));
      child.stdin?.on('error', this.failHelper.bind(this, state));
      child.once('error', error => { state.error = error; });
      // close는 stdout/stderr 배출 뒤 발생하므로 마지막 실패 이벤트까지 확인한다.
      child.once('close', this.handleHelperClose.bind(this, state));
      started?.(run);
      child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    } catch (error) {
      reject(error);
    }
    return run;
  }

  dispose(): void {
    for (const child of this.children) child.kill();
  }

  private handleStdoutData(state: HelperState, chunk: string): void {
    state.diagnosticBytes += Buffer.byteLength(chunk);
    if (state.diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
      this.failHelper(state, new Error('Native toast diagnostics exceed 32 KiB'));
      return;
    }
    state.stdoutBuffer += chunk;
    try {
      // 완성된 진단 프레임만 순서대로 전달하며 파싱·수신 실패 시 남은 프레임 처리를 멈춘다.
      while (true) {
        const newline = state.stdoutBuffer.indexOf('\n');
        if (newline < 0) return;
        const line = state.stdoutBuffer.slice(0, newline);
        state.stdoutBuffer = state.stdoutBuffer.slice(newline + 1);
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          throw new Error('Invalid native toast diagnostics');
        }
        const receive = state.receive;
        receive(event as Record<string, unknown>);
      }
    } catch (cause) {
      this.failHelper(state, cause);
    }
  }

  private failHelper(state: HelperState, cause: unknown): void {
    state.error ??= cause instanceof Error ? cause : new Error(String(cause));
    state.child.kill();
  }

  private handleHelperClose(state: HelperState, code: number | null, signal: NodeJS.Signals | null): void {
    clearTimeout(state.timer);
    this.children.delete(state.child);
    if (state.args[0] === '--show') {
      this.diagnostics.trace('toast.exit', {
        code, signal, notificationId: (state.input as { notificationId: string }).notificationId
      });
    }
    if (state.error) {
      state.reject(state.error);
      return;
    }

    const incompleteDiagnostics = state.stdoutBuffer.trim().length > 0;
    if (code !== 0 || incompleteDiagnostics) {
      const message = state.stderr.trim()
        || `Native toast helper exited: ${code}; incomplete diagnostics: ${incompleteDiagnostics}`;
      state.reject(new Error(message));
      return;
    }
    state.resolve();
  }
}

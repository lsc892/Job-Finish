// 네이티브 토스트 도우미 프로세스의 입출력·시간 제한·종료를 관리한다.
import { ChildProcess, spawn } from 'node:child_process';
import { Diagnostics } from '../core/model';

export interface ToastProcessPorts { launch(binary: string, args: string[]): ChildProcess }
export interface ToastProcessRun { readonly pid: number | undefined; readonly completion: Promise<void>; cancel(): void }
const processes: ToastProcessPorts = { launch: (binary, args) => spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) };
const HELPER_TIMEOUT_MS = 15_000;
const MAX_STDERR_CHARACTERS = 8192;
const MAX_DIAGNOSTIC_BYTES = 32768;

/** 등록·전달 도우미의 입출력·시간 제한을 처리하고 스트림 종료까지 프로세스를 관리한다. */
export class ToastProcessRunner {
  private readonly children = new Set<ChildProcess>();
  constructor(private binary: string, private diagnostics: Diagnostics, private ports: ToastProcessPorts = processes) {}

  run(args: string[], input: unknown, receive: (event: Record<string, unknown>) => void,
    started?: (run: ToastProcessRun) => void): ToastProcessRun {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    let child: ChildProcess | undefined;
    const run: ToastProcessRun = { get pid() { return child?.pid; }, completion, cancel: () => { child?.kill(); } };
    try {
      child = this.ports.launch(this.binary, args);
      const helper = child;
      this.children.add(helper);
      let stderr = '';
      let buffer = '';
      let bytes = 0;
      let error: Error | undefined;
      const fail = (cause: unknown) => { error ??= cause instanceof Error ? cause : new Error(String(cause)); helper.kill(); };
      const timer = setTimeout(() => { fail(new Error('Native toast helper timed out')); reject(error); }, HELPER_TIMEOUT_MS);
      helper.stdout?.setEncoding('utf8'); helper.stderr?.setEncoding('utf8');
      helper.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, MAX_STDERR_CHARACTERS); });
      helper.stdout?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_DIAGNOSTIC_BYTES) { fail(new Error('Native toast diagnostics exceed 32 KiB')); return; }
        buffer += chunk;
        try {
          for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            const event: unknown = JSON.parse(line);
            if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid native toast diagnostics');
            receive(event as Record<string, unknown>);
          }
        } catch (cause) { fail(cause); }
      });
      helper.stdin?.on('error', fail);
      helper.once('error', cause => { error = cause; });
      // close follows drained stdout/stderr; exit alone can lose the final failure event.
      helper.once('close', (code, signal) => {
        clearTimeout(timer); this.children.delete(helper);
        if (args[0] === '--show') this.diagnostics.trace('toast.exit', { code, signal, notificationId: (input as { notificationId: string }).notificationId });
        if (error || code !== 0 || buffer.trim()) reject(error ?? new Error(stderr.trim() || `Native toast helper exited: ${code}; incomplete diagnostics: ${!!buffer.trim()}`));
        else resolve();
      });
      started?.(run);
      helper.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    } catch (error) { reject(error); }
    return run;
  }

  dispose(): void { for (const child of this.children) child.kill(); }
}

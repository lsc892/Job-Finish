import { ChildProcess, spawn } from 'node:child_process';
import { createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Diagnostics, toastText } from '../core/model';

export interface ToastTarget { hwnd: string; pid: number; executable: string }
export interface ToastRequest {
  notificationId: string; windowInstanceId: string; title: string; message: string; appId: string;
  target?: ToastTarget; canActivate?: () => boolean; onClick?: () => void;
}
export interface ToastProcessPorts { launch(binary: string, args: string[]): ChildProcess }
const processes: ToastProcessPorts = { launch: (binary, args) => spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) };
/** The extension authorizes a click; the native protocol process performs focus itself. */
export class WindowsToast {
  static readonly appId = 'JobFinish.VSCode';
  private active?: { child?: ChildProcess; server: Server; sockets: Set<Socket>; timer: NodeJS.Timeout; id: string; cancel?: () => void };
  private generation = 0;
  private disposed = false;
  private registration?: Promise<void>;
  private readonly children = new Set<ChildProcess>();
  constructor(private binary: string, private diagnostics: Diagnostics, private processPorts: ToastProcessPorts = processes) {}
  static binary(extensionPath: string): string { return join(extensionPath, 'dist', 'native', 'JobFinish.Native.exe'); }
  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.registration) return this.registration;
    let ready = false;
    this.registration = this.runNative(['--register'], undefined, event => {
      if (event.event !== 'toast.registration.ready' || event.appId !== WindowsToast.appId) throw new Error('Invalid native registration response');
      ready = true;
      this.diagnostics.trace('toast.registration.ready', { appId: event.appId, changed: event.changed, legacyBackup: event.legacyBackup, setting: event.setting });
    }).then(() => { if (!ready) throw new Error('Native registration exited without confirming readiness'); }).catch(error => {
      this.registration = undefined;
      this.diagnostics.trace('toast.registration.failed');
      throw error;
    });
    return this.registration;
  }

  private runNative(args: string[], input: unknown, receive: (event: Record<string, unknown>) => void,
    started?: (child: ChildProcess) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.processPorts.launch(this.binary, args);
      this.children.add(child);
      let stderr = ''; let buffer = ''; let bytes = 0; let error: Error | undefined;
      const fail = (cause: unknown) => { error ??= cause instanceof Error ? cause : new Error(String(cause)); child.kill(); };
      const timer = setTimeout(() => { fail(new Error('Native toast helper timed out')); reject(error); }, 15_000);
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 8192); });
      child.stdout?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 32768) { fail(new Error('Native toast diagnostics exceed 32 KiB')); return; }
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
      child.stdin?.on('error', fail);
      child.once('error', cause => { error = cause; });
      // close follows drained stdout/stderr; exit alone can lose the final failure event.
      child.once('close', (code, signal) => {
        clearTimeout(timer); this.children.delete(child);
        if (args[0] === '--show') this.diagnostics.trace('toast.exit', { code, signal, notificationId: (input as ToastRequest).notificationId });
        if (error || code !== 0 || buffer.trim()) reject(error ?? new Error(stderr.trim() || `Native toast helper exited: ${code}; incomplete diagnostics: ${!!buffer.trim()}`));
        else resolve();
      });
      started?.(child);
      child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async show(request: ToastRequest, stillAllowed: () => boolean = () => true): Promise<void> {
    if (this.disposed) return;
    if (request.appId !== WindowsToast.appId) throw new Error('Toast app ID does not match registered application');
    if (!request.title.trim() || !request.message.trim()) throw new Error('Toast title and message must not be empty');
    const generation = ++this.generation;
    this.active?.cancel?.();
    this.clear();
    if (!stillAllowed()) return;
    await this.initialize();
    if (this.disposed || generation !== this.generation || !stillAllowed()) return;
    const pipe = `job-finish-${randomUUID()}`;
    const sockets = new Set<Socket>();
    let clicked = false;
    let authorizedSocket: Socket | undefined;
    let completed = false;
    const server = createServer(socket => {
      if (sockets.size >= 4) { socket.destroy(); return; }
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.on('error', error => this.diagnostics.add(error));
      socket.setTimeout(5000, () => socket.destroy());
      let received = '';
      let bytes = 0;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        received += chunk;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8192) { this.diagnostics.add('Native toast callback exceeds 8 KiB'); socket.destroy(); return; }
        for (let newline; (newline = received.indexOf('\n')) >= 0;) {
          const line = received.slice(0, newline); received = received.slice(newline + 1);
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.notificationId !== request.notificationId || event.windowInstanceId !== request.windowInstanceId) { socket.destroy(); return; }
            if (event.event === 'toast.click') {
              const allowed = !clicked && !this.disposed && this.active?.id === request.notificationId && (request.canActivate?.() ?? true);
              socket.write(JSON.stringify({ allowed }) + '\n');
              if (!allowed) { socket.end(); return; }
              clicked = true;
              authorizedSocket = socket;
              this.diagnostics.trace('toast.click', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId, source: 'native-protocol' });
              this.diagnostics.trace('window.activation.request', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId, hwnd: request.target?.hwnd, source: 'native-protocol' });
            } else if (event.event === 'window.activation.result' && socket === authorizedSocket && !completed) {
              completed = true;
              this.diagnostics.trace('window.activation.result', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId,
                activated: event.activated === true, reason: event.reason, hwnd: event.hwnd, foreground: event.foreground, source: 'native-protocol' });
              if (event.activated !== true) this.diagnostics.add(`Native toast activation failed: ${String(event.reason)}`);
              try { request.onClick?.(); } catch (error) { this.diagnostics.add(error); }
              socket.end();
            }
          } catch (error) { this.diagnostics.add(error); socket.destroy(); }
        }
      });
    });
    const timer = setTimeout(() => this.clear(request.notificationId), 300_000);
    this.active = { server, sockets, timer, id: request.notificationId };
    await new Promise<void>((resolve, reject) => {
      this.active!.cancel = resolve;
      server.once('error', error => { this.clear(request.notificationId); reject(error); });
      server.listen(`\\\\.\\pipe\\${pipe}`, () => {
        if (this.disposed || generation !== this.generation || !stillAllowed()) { this.clear(request.notificationId); resolve(); return; }
        try {
          let submitted = false; let observed = false; let failed = false;
          void this.runNative(['--show'], { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId,
            title: request.title, message: toastText(request.message), appId: request.appId, target: request.target, pipe }, event => {
            if (event.notificationId !== request.notificationId || event.windowInstanceId !== request.windowInstanceId) throw new Error('Native toast diagnostic IDs do not match');
            if (!['toast.submitted', 'toast.history.confirmed', 'toast.history.error', 'toast.failed', 'toast.observation.complete'].includes(String(event.event))) throw new Error('Unknown native toast diagnostic');
            submitted ||= event.event === 'toast.submitted'; observed ||= event.event === 'toast.observation.complete'; failed ||= event.event === 'toast.failed';
            this.diagnostics.trace(String(event.event), { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId,
              errorCode: event.errorCode, historyConfirmed: event.historyConfirmed, notificationState: event.notificationState, bannerVerified: false });
          }, child => {
            this.active!.child = child;
            this.diagnostics.trace('toast.launched', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId, helperPid: child.pid, hwnd: request.target?.hwnd });
          }).then(() => {
            if (!submitted || !observed || failed) throw new Error('Native toast delivery was not confirmed by the helper');
            if (this.active?.id === request.notificationId) this.active.child = undefined;
            resolve();
          }).catch(error => { this.clear(request.notificationId); reject(error); });
        } catch (error) { this.clear(request.notificationId); reject(error); }
      });
    });
  }
  private clear(id?: string): void {
    const active = this.active; if (!active || (id && active.id !== id)) return;
    this.active = undefined; clearTimeout(active.timer);
    for (const socket of active.sockets) socket.destroy();
    active.server.close(); active.child?.kill();
  }
  stop(): void { this.generation++; this.active?.cancel?.(); this.clear(); }
  dispose(): void { this.disposed = true; this.stop(); for (const child of this.children) child.kill(); }
}

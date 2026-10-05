import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Diagnostics, toastText } from '../core/model';

export interface ToastRequest { notificationId: string; windowInstanceId: string; title: string; message: string; appId: string; onClick?: () => void }
export interface ToastProcessPorts {
  register(binary: string, codeExecutable: string, appId: string): Promise<void>;
  launch(binary: string, args: string[]): ChildProcess;
}
const processes: ToastProcessPorts = {
  register: (binary, codeExecutable, appId) => promisify(execFile)(binary, ['-install', 'Job-Finish.lnk', codeExecutable, appId], { windowsHide: true, timeout: 10_000 }).then(() => undefined),
  launch: (binary, args) => spawn(binary, args, { windowsHide: true, stdio: 'ignore' }),
};
/** Uses node-notifier's packaged SnoreToast binary, with bounded child/pipe lifetime. */
export class WindowsToast {
  static readonly appId = 'JobFinish.VSCode';
  private binary = join(require.resolve('node-notifier/package.json'), '..', 'vendor', 'snoreToast', `snoretoast-x${process.arch === 'x64' ? '64' : '86'}.exe`);
  private registration?: Promise<void>;
  private active?: { child?: ChildProcess; server: Server; sockets: Set<Socket>; timer: NodeJS.Timeout; exitTimer?: NodeJS.Timeout; id: string };
  private generation = 0;
  private disposed = false;
  constructor(private codeExecutable: string, private diagnostics: Diagnostics, private processPorts: ToastProcessPorts = processes) {}
  private register(): Promise<void> {
    return this.registration ??= this.processPorts.register(this.binary, this.codeExecutable, WindowsToast.appId).catch(error => { this.registration = undefined; throw error; });
  }
  async show(request: ToastRequest, stillAllowed: () => boolean = () => true): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    if (request.appId !== WindowsToast.appId) throw new Error('Toast app ID does not match registered shortcut');
    await this.register();
    if (this.disposed || generation !== this.generation || !stillAllowed()) return;
    this.clear();
    const pipe = `\\\\.\\pipe\\job-finish-${randomUUID()}`;
    let receivedBytes = 0;
    let clicked = false; const sockets = new Set<Socket>();
    const server = createServer(socket => {
      if (sockets.size >= 4) { socket.destroy(); return; }
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.on('error', error => this.diagnostics.add(error));
      let received = Buffer.alloc(0);
      const parse = (complete: boolean) => {
        if (clicked || this.active?.id !== request.notificationId || received.length % 2) return;
        const text = received.toString('utf16le');
        // Do not mistake the partial prefix "activate" in a longer, split action for a click.
        const match = /(?:^|;)action=activate(?:d)?(?:;|\u0000)/.test(text) || complete && /(?:^|;)action=activate(?:d)?$/.test(text);
        if (match) { clicked = true; try { request.onClick?.(); } catch (error) { this.diagnostics.add(error); } }
      };
      socket.on('end', () => parse(true));
      socket.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > 8192) { this.diagnostics.add('Toast callback exceeds 8 KiB'); socket.destroy(); return; }
        received = Buffer.concat([received, chunk]);
        parse(false);
      });
    });
    server.on('error', error => { this.diagnostics.add(error); this.clear(request.notificationId); });
    const timer = setTimeout(() => this.clear(request.notificationId), 30_000);
    this.active = { server, sockets, timer, id: request.notificationId };
    server.listen(pipe, () => {
      if (!this.active || this.active.id !== request.notificationId || !stillAllowed()) { this.clear(request.notificationId); return; }
      let child: ChildProcess;
      try { child = this.processPorts.launch(this.binary, ['-t', request.title, '-m', toastText(request.message), '-appID', request.appId, '-id', request.notificationId, '-pipeName', pipe]); }
      catch (error) { this.diagnostics.add(error); this.clear(request.notificationId); return; }
      this.active.child = child;
      child.on('error', error => { this.diagnostics.add(error); this.clear(request.notificationId); });
      child.on('exit', code => {
        // Windows can report native -1 as unsigned 0xffffffff. Codes 0..5 are documented outcomes.
        if (code !== null && (code < 0 || code > 5)) this.diagnostics.add(`SnoreToast failed: ${code}`);
        const active = this.active; if (!active || active.child !== child) return;
        // Pipe data and process exit are separate event sources; allow an in-flight click to drain.
        active.exitTimer = setTimeout(() => this.clear(request.notificationId), 250);
      });
    });
  }
  private clear(id?: string): void {
    const active = this.active; if (!active || (id && active.id !== id)) return;
    this.active = undefined; clearTimeout(active.timer); clearTimeout(active.exitTimer); for (const socket of active.sockets) socket.destroy(); active.server.close(); active.child?.kill();
  }
  dispose(): void { this.disposed = true; this.generation++; this.clear(); }
}

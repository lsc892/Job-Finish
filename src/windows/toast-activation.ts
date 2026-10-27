// 토스트 클릭 파이프에서 현재 알림의 활성화 권한과 실행 결과를 확인한다.
import { randomUUID } from 'node:crypto';
import { createServer, Server, Socket } from 'node:net';
import { Diagnostics } from '../core/model';

export interface ToastTarget { hwnd: string; pid: number; executable: string }
export interface ToastRequest {
  notificationId: string; windowInstanceId: string; title: string; message: string; appId: string;
  target?: ToastTarget; canActivate?: () => boolean; onClick?: () => void;
}
const CLICK_CHANNEL_LIFETIME_MS = 300_000;
const MAX_CLICK_SOCKETS = 4;
const CLICK_SOCKET_TIMEOUT_MS = 5000;
const MAX_CALLBACK_BYTES = 8192;

/** 알림별 클릭 채널을 유지하고 활성화 권한·결과를 검증한다. */
export class ToastActivation {
  readonly pipe = `job-finish-${randomUUID()}`;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly timer: NodeJS.Timeout;
  private clicked = false;
  private authorizedSocket?: Socket;
  private completed = false;
  constructor(private request: ToastRequest, private diagnostics: Diagnostics, private isCurrent: () => boolean, expired: () => void) {
    this.server = createServer(socket => this.connect(socket));
    this.timer = setTimeout(expired, CLICK_CHANNEL_LIFETIME_MS);
  }

  listen(ready: () => void, failed: (error: Error) => void): void {
    this.server.once('error', failed);
    this.server.listen(`\\\\.\\pipe\\${this.pipe}`, ready);
  }

  private connect(socket: Socket): void {
    if (this.sockets.size >= MAX_CLICK_SOCKETS) { socket.destroy(); return; }
    this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', error => this.diagnostics.add(error));
    socket.setTimeout(CLICK_SOCKET_TIMEOUT_MS, () => socket.destroy());
    let received = '';
    let bytes = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_CALLBACK_BYTES) { this.diagnostics.add('Native toast callback exceeds 8 KiB'); socket.destroy(); return; }
      for (let newline; (newline = received.indexOf('\n')) >= 0;) {
        const line = received.slice(0, newline); received = received.slice(newline + 1);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.notificationId !== this.request.notificationId || event.windowInstanceId !== this.request.windowInstanceId) { socket.destroy(); return; }
          if (event.event === 'toast.click') {
            if (!this.authorizeClick(socket)) return;
          } else if (event.event === 'window.activation.result') this.completeActivation(socket, event);
        } catch (error) { this.diagnostics.add(error); socket.destroy(); }
      }
    });
  }

  private authorizeClick(socket: Socket): boolean {
    const request = this.request;
    const allowed = !this.clicked && this.isCurrent() && (request.canActivate?.() ?? true);
    socket.write(JSON.stringify({ allowed }) + '\n');
    if (!allowed) { socket.end(); return false; }
    this.clicked = true;
    this.authorizedSocket = socket;
    this.diagnostics.trace('toast.click', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId, source: 'native-toast' });
    this.diagnostics.trace('window.activation.request', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId, hwnd: request.target?.hwnd, source: 'native-toast' });
    return true;
  }

  private completeActivation(socket: Socket, event: Record<string, unknown>): void {
    if (socket !== this.authorizedSocket || this.completed) return;
    this.completed = true;
    const request = this.request;
    this.diagnostics.trace('window.activation.result', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId,
      activated: event.activated === true, reason: event.reason, hwnd: event.hwnd, foreground: event.foreground, source: 'native-toast' });
    if (event.activated !== true) this.diagnostics.add(`Native toast activation failed: ${String(event.reason)}`);
    try { request.onClick?.(); } catch (error) { this.diagnostics.add(error); }
    socket.end();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }
}

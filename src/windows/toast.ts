// 네이티브 도우미의 등록·토스트 전달·클릭 채널 수명을 조율한다.
import { join } from 'node:path';
import { Diagnostics, toastText } from '../core/model';
import { ToastActivation, ToastRequest } from './toast-activation';
import { ToastProcessPorts, ToastProcessRun, ToastProcessRunner } from './toast-process';

export type { ToastTarget, ToastRequest } from './toast-activation';
export type { ToastProcessPorts } from './toast-process';
const DELIVERY_EVENTS = ['toast.submitted', 'toast.history.confirmed', 'toast.history.error', 'toast.failed', 'toast.observation.complete'];
/** 토스트 도우미 등록·전달 확인과 현재 알림의 클릭 채널 수명을 조율한다. */
export class WindowsToast {
  static readonly appId = 'JobFinish.VSCode';
  private active?: { process?: ToastProcessRun; activation: ToastActivation; id: string; cancel?: () => void };
  private generation = 0;
  private disposed = false;
  private registration?: Promise<void>;
  private readonly processes: ToastProcessRunner;
  constructor(binary: string, private diagnostics: Diagnostics, processPorts?: ToastProcessPorts) {
    this.processes = new ToastProcessRunner(binary, diagnostics, processPorts);
  }
  static binary(extensionPath: string): string { return join(extensionPath, 'dist', 'native', 'JobFinish.Native.exe'); }
  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.registration) return this.registration;
    let ready = false;
    this.registration = this.processes.run(['--register'], undefined, event => {
      if (event.event !== 'toast.registration.ready' || event.appId !== WindowsToast.appId) throw new Error('Invalid native registration response');
      ready = true;
      this.diagnostics.trace('toast.registration.ready', { appId: event.appId, changed: event.changed, legacyBackup: event.legacyBackup, setting: event.setting });
    }).completion.then(() => { if (!ready) throw new Error('Native registration exited without confirming readiness'); }).catch(error => {
      this.registration = undefined;
      this.diagnostics.trace('toast.registration.failed');
      throw error;
    });
    return this.registration;
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
    const activation = new ToastActivation(request, this.diagnostics,
      () => !this.disposed && this.active?.id === request.notificationId, () => this.clear(request.notificationId));
    this.active = { activation, id: request.notificationId };
    await new Promise<void>((resolve, reject) => {
      this.active!.cancel = resolve;
      activation.listen(() => {
        if (this.disposed || generation !== this.generation || !stillAllowed()) { this.clear(request.notificationId); resolve(); return; }
        this.launchToast(request, activation.pipe, resolve, error => { this.clear(request.notificationId); reject(error); });
      }, error => { this.clear(request.notificationId); reject(error); });
    });
  }
  private launchToast(request: ToastRequest, pipe: string, delivered: () => void, failed: (error: unknown) => void): void {
    try {
      let submitted = false;
      let observed = false;
      let deliveryFailed = false;
      void this.processes.run(['--show'], { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId,
        title: request.title, message: toastText(request.message), appId: request.appId, target: request.target, pipe }, event => {
        if (event.notificationId !== request.notificationId || event.windowInstanceId !== request.windowInstanceId) throw new Error('Native toast diagnostic IDs do not match');
        if (!DELIVERY_EVENTS.includes(String(event.event))) throw new Error('Unknown native toast diagnostic');
        submitted ||= event.event === 'toast.submitted';
        observed ||= event.event === 'toast.observation.complete';
        deliveryFailed ||= event.event === 'toast.failed';
        this.diagnostics.trace(String(event.event), { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId,
          errorCode: event.errorCode, historyConfirmed: event.historyConfirmed, notificationState: event.notificationState, bannerVerified: false });
      }, run => {
        this.active!.process = run;
        this.diagnostics.trace('toast.launched', { notificationId: request.notificationId, windowInstanceId: request.windowInstanceId, helperPid: run.pid, hwnd: request.target?.hwnd });
      }).completion.then(() => {
        if (!submitted || !observed || deliveryFailed) throw new Error('Native toast delivery was not confirmed by the helper');
        if (this.active?.id === request.notificationId) this.active.process = undefined;
        delivered();
      }).catch(failed);
    } catch (error) { failed(error); }
  }
  private clear(id?: string): void {
    const active = this.active; if (!active || (id && active.id !== id)) return;
    this.active = undefined;
    active.activation.dispose(); active.process?.cancel();
  }
  stop(): void { this.generation++; this.active?.cancel?.(); this.clear(); }
  dispose(): void { this.disposed = true; this.stop(); this.processes.dispose(); }
}

// 네이티브 도우미의 등록·토스트 전달·클릭 채널 수명을 조율한다.
import { join } from 'node:path';
import { Diagnostics, toastText } from '../core/model';
import { ToastActivation, ToastRequest } from './toast-activation';
import { ToastProcessPorts, ToastProcessRun, ToastProcessRunner } from './toast-process';

export type { ToastTarget, ToastRequest } from './toast-activation';
export type { ToastProcessPorts } from './toast-process';

const DELIVERY_EVENTS = [
  'toast.submitted',
  'toast.history.confirmed',
  'toast.history.error',
  'toast.failed',
  'toast.observation.complete'
];

interface RegistrationState {
  ready: boolean;
}

interface DeliveryState {
  submitted: boolean;
  observationComplete: boolean;
  failed: boolean;
}

interface ActiveToast {
  id: string;
  activation: ToastActivation;
  process?: ToastProcessRun;
  finishDelivery?: () => void;
}

/** 토스트 도우미 등록·전달 확인과 현재 알림의 클릭 채널 수명을 조율한다. */
export class WindowsToast {
  static readonly appId = 'JobFinish.VSCode';
  private active?: ActiveToast;
  private generation = 0;
  private disposed = false;
  private registration?: Promise<void>;
  private readonly processes: ToastProcessRunner;

  constructor(binary: string, private diagnostics: Diagnostics, processPorts?: ToastProcessPorts, private codeExecutable?: string) {
    this.processes = new ToastProcessRunner(binary, diagnostics, processPorts);
  }

  static binary(extensionPath: string): string {
    return join(extensionPath, 'dist', 'native', 'JobFinish.Native.exe');
  }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.registration) return this.registration;
    const state: RegistrationState = { ready: false };
    const args = this.codeExecutable ? ['--register', this.codeExecutable] : ['--register'];
    const run = this.processes.run(args, undefined, this.handleRegistrationEvent.bind(this, state));
    this.registration = run.completion
      .then(this.confirmRegistration.bind(this, state))
      .catch(this.handleRegistrationFailure.bind(this));
    return this.registration;
  }

  async show(request: ToastRequest, stillAllowed: () => boolean = () => true): Promise<void> {
    if (this.disposed) return;
    this.validateRequest(request);

    const generation = ++this.generation;
    this.cancelActiveToast();
    if (!stillAllowed()) return;

    await this.initialize();
    if (!this.isDeliveryAllowed(generation, stillAllowed)) return;
    await this.waitForDelivery(request, generation, stillAllowed);
  }

  stop(): void {
    this.generation++;
    this.cancelActiveToast();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.processes.dispose();
  }

  private handleRegistrationEvent(state: RegistrationState, event: Record<string, unknown>): void {
    if (event.event !== 'toast.registration.ready' || event.appId !== WindowsToast.appId) {
      throw new Error('Invalid native registration response');
    }
    state.ready = true;
    this.diagnostics.trace('toast.registration.ready', {
      appId: event.appId,
      changed: event.changed,
      legacyBackup: event.legacyBackup,
      setting: event.setting,
      iconRegistered: event.iconRegistered
    });
  }

  private confirmRegistration(state: RegistrationState): void {
    if (!state.ready) throw new Error('Native registration exited without confirming readiness');
  }

  private handleRegistrationFailure(error: unknown): never {
    this.registration = undefined;
    this.diagnostics.trace('toast.registration.failed');
    throw error;
  }

  private validateRequest(request: ToastRequest): void {
    if (request.appId !== WindowsToast.appId) {
      throw new Error('Toast app ID does not match registered application');
    }
    if (!request.title.trim() || !request.message.trim()) {
      throw new Error('Toast title and message must not be empty');
    }
  }

  private isDeliveryAllowed(generation: number, stillAllowed: () => boolean): boolean {
    return !this.disposed && generation === this.generation && stillAllowed();
  }

  private waitForDelivery(request: ToastRequest, generation: number, stillAllowed: () => boolean): Promise<void> {
    const activation = new ToastActivation(
      request,
      this.diagnostics,
      this.isCurrentNotification.bind(this, request.notificationId),
      this.clear.bind(this, request.notificationId)
    );
    const active: ActiveToast = { activation, id: request.notificationId };
    this.active = active;

    return new Promise<void>((resolve, reject) => {
      const handleChannelFailure = (error: unknown): void => {
        this.clear(request.notificationId);
        reject(error);
      };
      const handleChannelReady = (): void => {
        if (!this.isDeliveryAllowed(generation, stillAllowed)) {
          this.clear(request.notificationId);
          resolve();
          return;
        }
        this.launchToast(request, activation.pipe, resolve, handleChannelFailure);
      };

      active.finishDelivery = resolve;
      activation.listen(handleChannelReady, handleChannelFailure);
    });
  }

  private isCurrentNotification(id: string): boolean {
    return !this.disposed && this.active?.id === id;
  }

  private launchToast(request: ToastRequest, pipe: string, delivered: () => void, failed: (error: unknown) => void): void {
    try {
      const state: DeliveryState = { submitted: false, observationComplete: false, failed: false };
      const input = {
        notificationId: request.notificationId,
        windowInstanceId: request.windowInstanceId,
        title: request.title,
        message: toastText(request.message),
        imagePath: request.imagePath,
        appId: request.appId,
        target: request.target,
        pipe
      };
      const run = this.processes.run(
        ['--show'],
        input,
        this.handleDeliveryEvent.bind(this, request, state),
        this.handleHelperStarted.bind(this, request)
      );
      void run.completion.then(this.completeDelivery.bind(this, request, state, delivered)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  private handleDeliveryEvent(request: ToastRequest, state: DeliveryState, event: Record<string, unknown>): void {
    if (event.notificationId !== request.notificationId || event.windowInstanceId !== request.windowInstanceId) {
      throw new Error('Native toast diagnostic IDs do not match');
    }
    if (!DELIVERY_EVENTS.includes(String(event.event))) throw new Error('Unknown native toast diagnostic');
    state.submitted ||= event.event === 'toast.submitted';
    state.observationComplete ||= event.event === 'toast.observation.complete';
    state.failed ||= event.event === 'toast.failed';
    this.diagnostics.trace(String(event.event), {
      notificationId: request.notificationId,
      windowInstanceId: request.windowInstanceId,
      errorCode: event.errorCode,
      historyConfirmed: event.historyConfirmed,
      notificationState: event.notificationState,
      bannerVerified: false
    });
  }

  private handleHelperStarted(request: ToastRequest, run: ToastProcessRun): void {
    this.active!.process = run;
    this.diagnostics.trace('toast.launched', {
      notificationId: request.notificationId,
      windowInstanceId: request.windowInstanceId,
      helperPid: run.pid,
      hwnd: request.target?.hwnd
    });
  }

  private completeDelivery(request: ToastRequest, state: DeliveryState, delivered: () => void): void {
    if (!state.submitted || !state.observationComplete || state.failed) {
      throw new Error('Native toast delivery was not confirmed by the helper');
    }
    if (this.active?.id === request.notificationId) this.active.process = undefined;
    delivered();
  }

  private cancelActiveToast(): void {
    // 교체·중지 시 show() 대기를 먼저 해소하고 클릭 채널과 helper를 정리한다.
    this.active?.finishDelivery?.();
    this.clear();
  }

  private clear(id?: string): void {
    const active = this.active;
    if (!active || (id && active.id !== id)) return;
    this.active = undefined;
    active.activation.dispose();
    active.process?.cancel();
  }
}

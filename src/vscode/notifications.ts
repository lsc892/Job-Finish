// 자동 실행 관찰과 알림 전달을 현재 VS Code 창·설정·소유권에 연결한다.
import * as vscode from 'vscode';
import { Diagnostics, Signal } from '../core/model';
import { notificationTitle, Notifications } from '../core/notifications';
import { AgentStreamObserver, AgentRoot } from '../runtime/observe';
import { agentProviders } from '../runtime/providers';
import { WindowsToast } from '../windows/toast';
import { toastImagePath } from '../windows/toast/image';
import { CodeWindow } from './window';

interface NotificationPorts {
  config<T>(key: string, fallback: T): T;
}

/** 자동 관찰·결과 알림·Windows 토스트를 현재 창의 설정과 소유권에 연결한다. */
export class WindowNotifications {
  readonly window: CodeWindow;
  private readonly observer: AgentStreamObserver;
  private readonly toast: WindowsToast;
  private readonly notifications: Notifications;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, windowInstanceId: string,
    private readonly diagnostics: Diagnostics,
    private readonly ports: NotificationPorts) {
    this.toast = new WindowsToast(WindowsToast.binary(context.extensionPath), diagnostics, undefined, process.execPath);
    this.observer = new AgentStreamObserver(windowInstanceId, () => this.agentRoots(), signal => this.receive(signal),
      diagnostics);
    this.window = new CodeWindow(windowInstanceId, diagnostics);
    this.notifications = new Notifications({
      trace: (event, fields) => diagnostics.trace(event, fields),
      enabled: () => ports.config('enabled', true),
      focused: () => vscode.window.state.focused,
      owns: signal => this.owns(signal),
      stopFlash: id => this.window.stopFlash(id),
      activate: signal => { diagnostics.trace('notification.click.handled', { notificationId: signal.notificationId, windowInstanceId }); },
      flash: signal => {
        if (ports.config('flash', true)) {
          this.window.startFlash(signal.notificationId, ports.config('flashMode', 'manual'), ports.config('flashTimeoutSeconds', 300) * 1000);
        }
      },
      toast: (signal, message, click, allowed) => this.showToast(signal, message, click, allowed),
    });
  }

  get results(): Signal[] { return this.notifications.results; }
  automatic() { return this.observer.snapshot(); }

  private owns(signal: Signal): boolean {
    return this.observer.owns(signal);
  }

  private agentRoots(): AgentRoot[] {
    if (this.context.extensionMode === vscode.ExtensionMode.Test && process.env.JOB_FINISH_TEST_AGENT_ROOT) {
      return Object.values(agentProviders).map(provider => ({ provider: provider.id, path: process.env.JOB_FINISH_TEST_AGENT_ROOT! }));
    }
    return Object.values(agentProviders).flatMap(provider => {
      const extension = vscode.extensions.getExtension(provider.extensionId);
      return extension ? [{ provider: provider.id, path: extension.extensionPath }] : [];
    });
  }

  configure(): void {
    const config = this.ports.config;
    this.diagnostics.trace('notifications.configured', { windowInstanceId: this.window.windowInstanceId,
      enabled: config('enabled', true), toast: config('toast', true), flash: config('flash', true),
      focused: vscode.window.state.focused,
      providers: Object.values(agentProviders).map(provider => ({ provider: provider.id, extensionId: provider.extensionId,
        version: vscode.extensions.getExtension(provider.extensionId)?.packageJSON.version ?? null })) });
    if (config('enabled', true) && config('toast', true)) void this.toast.initialize().catch(error => this.diagnostics.add(error, { stage: 'toast-registration' }));
    if (config('enabled', true)) this.observer.start();
    else {
      this.observer.stop();
      this.window.stopFlash();
      this.toast.stop();
    }
    if (!config('toast', true)) this.toast.stop();
    if (!config('flash', true)) this.window.stopFlash();
  }

  receive(signal: Signal): void {
    this.diagnostics.trace('signal.received', { windowInstanceId: signal.windowInstanceId, notificationId: signal.notificationId,
      provider: signal.provider, runtimeId: signal.runtimeId, connectionId: signal.connectionId,
      sessionId: signal.sessionId, turnId: signal.turnId, status: signal.status, kind: signal.kind,
      textCharacters: signal.text.length, owned: this.owns(signal), focused: vscode.window.state.focused });
    void this.notifications.deliver(signal).catch(error => this.diagnostics.add(error, {
      stage: 'notification-delivery', notificationId: signal.notificationId, windowInstanceId: signal.windowInstanceId,
      provider: signal.provider, connectionId: signal.connectionId, sessionId: signal.sessionId, turnId: signal.turnId }));
  }

  private async showToast(signal: Signal, message: string, click: () => void, allowed: () => boolean): Promise<void> {
    const binding = this.window.valid();
    if (!this.ports.config('toast', true)) {
      this.diagnostics.trace('toast.skipped', { notificationId: signal.notificationId,
        windowInstanceId: signal.windowInstanceId, reason: 'toast-disabled' });
      return;
    }
    const windowInstanceId = this.window.windowInstanceId;
    this.diagnostics.trace('toast.requested', { notificationId: signal.notificationId, windowInstanceId,
      bound: !!binding, hwnd: binding?.hwnd.toString(), messageCharacters: message.length });
    await this.toast.show({
      notificationId: signal.notificationId,
      windowInstanceId,
      title: notificationTitle(signal),
      message,
      appId: WindowsToast.appId,
      imagePath: toastImagePath(this.context.extensionPath, this.ports.config('toastIcon', true), this.ports.config('toastIconPath', ''),
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, message => this.diagnostics.add(message)),
      onClick: click,
      target: binding ? { hwnd: binding.hwnd.toString(), pid: binding.pid, executable: binding.executable } : undefined,
      canActivate: () => !this.disposed && this.ports.config('enabled', true) && this.owns(signal),
    }, allowed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.dispose();
    this.window.dispose();
    this.toast.dispose();
  }
}

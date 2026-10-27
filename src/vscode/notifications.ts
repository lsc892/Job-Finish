// 자동 실행 관찰과 알림 전달을 현재 VS Code 창·설정·소유권에 연결한다.
import * as vscode from 'vscode';
import type { ApplicationSessions } from '../application/sessions';
import { Diagnostics, Signal } from '../core/model';
import { Notifications } from '../core/notifications';
import { AgentStreamObserver, AgentRoot } from '../runtime/observe';
import { agentProviders } from '../runtime/providers';
import { WindowsToast } from '../windows/toast';
import { CodeWindow } from './window';

interface NotificationPorts {
  config<T>(key: string, fallback: T): T;
  changed(): void;
}

/** 자동 관찰·결과 알림·Windows 토스트를 현재 창의 설정과 소유권에 연결한다. */
export class WindowNotifications {
  readonly window: CodeWindow;
  private readonly observer: AgentStreamObserver;
  private readonly toast: WindowsToast;
  private readonly notifications: Notifications;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, windowInstanceId: string,
    private readonly sessions: Pick<ApplicationSessions, 'has' | 'owns'>, private readonly diagnostics: Diagnostics,
    private readonly ports: NotificationPorts) {
    this.toast = new WindowsToast(WindowsToast.binary(context.extensionPath), diagnostics);
    this.observer = new AgentStreamObserver(windowInstanceId, () => this.agentRoots(), signal => this.receive(signal),
      diagnostics, (provider, id) => sessions.has(provider, id));
    this.window = new CodeWindow(windowInstanceId, diagnostics);
    this.notifications = new Notifications({
      enabled: () => ports.config('enabled', true),
      focused: () => vscode.window.state.focused,
      owns: signal => this.owns(signal),
      stopFlash: id => this.window.stopFlash(id),
      activate: signal => { diagnostics.trace('notification.click.handled', { notificationId: signal.notificationId, windowInstanceId }); },
      flash: signal => this.flashNotification(signal),
      toast: (signal, message, click, allowed) => this.showToast(signal, message, click, allowed),
    });
  }

  get results(): Signal[] { return this.notifications.results; }
  automatic() { return this.observer.snapshot(); }

  private owns(signal: Signal): boolean {
    return signal.source === 'verifiedIntegration' ? this.observer.owns(signal) : this.sessions.owns(signal.sessionId);
  }

  private agentRoots(): AgentRoot[] {
    if (this.context.extensionMode === vscode.ExtensionMode.Test && process.env.JOB_FINISH_TEST_AGENT_ROOT) {
      return agentProviders.all().map(provider => ({ provider: provider.id, path: process.env.JOB_FINISH_TEST_AGENT_ROOT! }));
    }
    return agentProviders.all().flatMap(provider => {
      const extension = vscode.extensions.getExtension(provider.extensionId);
      return extension ? [{ provider: provider.id, path: extension.extensionPath }] : [];
    });
  }

  configure(): void {
    const config = this.ports.config;
    if (config('enabled', true) && config('toast', true)) void this.toast.initialize().catch(error => this.diagnostics.add(error));
    if (config('enabled', true)) this.observer.start();
    else {
      this.observer.stop();
      this.window.stopFlash();
      this.toast.stop();
    }
    if (!config('toast', true)) this.toast.stop();
    if (!config('flash', true)) this.window.stopFlash();
    this.ports.changed();
  }

  receive(signal: Signal): void {
    this.diagnostics.trace('signal.received', { windowInstanceId: signal.windowInstanceId, notificationId: signal.notificationId,
      provider: signal.provider, status: signal.status, owned: this.owns(signal), focused: vscode.window.state.focused });
    void this.notifications.deliver(signal).catch(error => this.diagnostics.add(error));
    this.ports.changed();
  }

  private flashNotification(signal: Signal): void {
    if (this.ports.config('flash', true)) {
      this.window.startFlash(signal.notificationId, this.ports.config('flashMode', 'manual'), this.ports.config('flashTimeoutSeconds', 300) * 1000);
    }
  }

  private async showToast(signal: Signal, message: string, click: () => void, allowed: () => boolean): Promise<void> {
    const binding = this.window.valid();
    if (!this.ports.config('toast', true)) return;
    const windowInstanceId = this.window.windowInstanceId;
    await this.toast.show({
      notificationId: signal.notificationId,
      windowInstanceId,
      title: `${signal.provider} · ${signal.status} · ${windowInstanceId.slice(0, 8)}`,
      message,
      appId: WindowsToast.appId,
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

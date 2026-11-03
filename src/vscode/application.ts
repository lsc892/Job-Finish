// VS Code 창의 자동 감지·알림·결과·진단을 구성한다.
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Diagnostics } from '../core/model';
import { WindowNotifications } from './notifications';
import { showResults } from './results';

const INITIAL_WINDOW_OBSERVATION_DELAY_MS = 750;

export class Application {
  readonly windowInstanceId = randomUUID();
  private readonly output = vscode.window.createOutputChannel('Job-Finish');
  private readonly diagnostics = new Diagnostics(entry => this.output.appendLine(JSON.stringify(entry)));
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private readonly notifications: WindowNotifications;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.notifications = new WindowNotifications(context, this.windowInstanceId, this.diagnostics, {
      config: (key, fallback) => this.config(key, fallback),
    });
  }

  async activate(): Promise<void> {
    this.notifications.configure();
    this.updateStatus();
    this.status.show();
    const commands: Record<string, () => unknown> = {
      results: () => showResults(this.notifications.results),
      bindWindow: () => this.notifications.window.bind(),
      stopFlash: () => this.notifications.window.stopFlash(),
      diagnostics: () => {
        this.output.clear();
        this.output.appendLine(JSON.stringify(this.api.snapshot(), (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
        this.output.show();
      },
    };
    for (const [name, handler] of Object.entries(commands)) {
      this.context.subscriptions.push(vscode.commands.registerCommand(`jobFinish.${name}`, async () => {
        try { await handler(); }
        catch (error) {
          this.diagnostics.add(error);
          void vscode.window.showErrorMessage(`Job-Finish: ${error}`);
        }
      }));
    }
    this.context.subscriptions.push(this.output, this.status, this.notifications.window.watchFocus(),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('jobFinish')) {
          this.notifications.configure();
          this.updateStatus();
        }
      }), { dispose: () => this.dispose() });
    await this.notifications.window.observe(INITIAL_WINDOW_OBSERVATION_DELAY_MS);
  }

  get api() { return {
    identity: () => ({ windowInstanceId: this.windowInstanceId, vscodeSessionId: vscode.env.sessionId, extensionHostPid: process.pid, workspaceUris: vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? [] }),
    snapshot: () => ({ enabled: this.config('enabled', true), automatic: this.notifications.automatic(), results: this.notifications.results, diagnostics: this.diagnostics.entries, events: this.diagnostics.events, native: this.notifications.window.binding }),
    ...(this.context.extensionMode === vscode.ExtensionMode.Test ? {
      test: {
        bind: () => this.notifications.window.observe(),
        flashId: () => this.notifications.window.flashId,
        unbind: () => this.notifications.window.unbind(),
      },
    } : {}),
  }; }

  private config<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('jobFinish').get<T>(key, fallback); }

  private updateStatus(): void {
    const enabled = this.config('enabled', true);
    this.status.text = `${enabled ? '$(bell)' : '$(bell-slash)'} JF ${this.windowInstanceId.slice(0, 8)} · ${enabled ? 'on' : 'off'}`;
    this.status.command = 'jobFinish.results';
    this.status.tooltip = 'Job-Finish · automatic notifications · Settings: Job-Finish Enabled · Show Results';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.notifications.dispose();
  }
}

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { ApplicationSessions } from '../application/sessions';
import { Diagnostics, Provider } from '../core/model';
import { Ownership } from '../core/ownership';
import { agentProviders } from '../runtime/providers';
import { SessionCommands } from './commands';
import { AgentInput } from './interaction';
import { WindowNotifications } from './notifications';
import { showResults } from './results';

const INITIAL_WINDOW_OBSERVATION_DELAY_MS = 750;

/** Composes window services and owns the extension API, diagnostics and status bar. */
export class Application {
  readonly windowInstanceId = randomUUID();
  private readonly diagnostics = new Diagnostics(entry => this.output.appendLine(JSON.stringify(entry)));
  private readonly sessions: ApplicationSessions;
  private readonly output = vscode.window.createOutputChannel('Job-Finish');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private readonly notifications: WindowNotifications;
  private readonly commands: SessionCommands;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const storage = context.extensionMode === vscode.ExtensionMode.Test && process.env.JOB_FINISH_TEST_SHARED_STORAGE
      ? process.env.JOB_FINISH_TEST_SHARED_STORAGE : context.globalStorageUri.fsPath;
    mkdirSync(storage, { recursive: true });
    const ownership = new Ownership(storage);
    this.sessions = new ApplicationSessions({
      windowInstanceId: this.windowInstanceId,
      diagnostics: this.diagnostics,
      trusted: () => vscode.workspace.isTrusted,
      config: (key, fallback) => this.config(key, fallback),
      provider: id => agentProviders.get(id),
      claim: binding => ownership.claim(binding),
      saved: () => context.workspaceState.get('sessions', []),
      save: sessions => context.workspaceState.update('sessions', sessions),
      signal: signal => this.notifications.receive(signal),
      changed: () => this.updateStatus(),
      released: () => this.notifications.window.stopFlash(),
    });
    this.notifications = new WindowNotifications(context, this.windowInstanceId, this.sessions, this.diagnostics, {
      config: (key, fallback) => this.config(key, fallback),
      changed: () => this.updateStatus(),
    });
    this.commands = new SessionCommands(this.sessions, new AgentInput(), {
      results: () => showResults(this.notifications.results, this.sessions),
      bindWindow: () => this.notifications.window.bind(),
      stopFlash: () => this.notifications.window.stopFlash(),
      diagnostics: () => this.showDiagnostics(),
      report: error => { this.diagnostics.add(error); void vscode.window.showErrorMessage(`Job-Finish: ${error}`); },
      changed: () => this.updateStatus(),
    });
  }

  async activate(): Promise<void> {
    this.notifications.configure();
    this.updateStatus();
    this.status.show();
    this.commands.register(this.context.subscriptions);
    this.context.subscriptions.push(this.output, this.status, this.notifications.window.watchFocus(),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('jobFinish')) this.notifications.configure();
      }), { dispose: () => this.dispose() });
    // Initial Extension Host focus state can precede the first real window-state event.
    await this.notifications.window.observe(INITIAL_WINDOW_OBSERVATION_DELAY_MS);
  }

  get api() { return {
    identity: () => ({ windowInstanceId: this.windowInstanceId, vscodeSessionId: vscode.env.sessionId, extensionHostPid: process.pid, workspaceUris: vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? [] }),
    snapshot: () => ({ enabled: this.config('enabled', true), automatic: this.notifications.automatic(), results: this.notifications.results, sessions: this.sessions.snapshot(), diagnostics: this.diagnostics.entries, events: this.diagnostics.events, native: this.notifications.window.binding }),
    // The same product path is available to Extension Host tests without automating prompt UI.
    ...(this.context.extensionMode === vscode.ExtensionMode.Test ? {
      test: {
        open: (provider: Provider, cwd: string, sessionId?: string) => this.sessions.open(provider, cwd, sessionId).then(entry => entry.session.binding.sessionId),
        run: (sessionId: string, prompt: string) => this.sessions.get(sessionId)!.execution.run(prompt),
        cancel: (sessionId: string) => this.sessions.get(sessionId)!.execution.cancel(),
        release: (sessionId: string) => this.sessions.detach(this.sessions.get(sessionId)!),
        bind: () => this.notifications.window.observe(),
        flashId: () => this.notifications.window.flashId,
        unbind: () => this.notifications.window.unbind(),
      },
    } : {}),
  }; }

  private config<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('jobFinish').get<T>(key, fallback); }

  private updateStatus(): void {
    const waiting = this.sessions.pendingRequests;
    const enabled = this.config('enabled', true);
    let icon = '$(bell)';
    let state = 'on';
    if (!enabled) {
      icon = '$(bell-slash)';
      state = 'off';
    } else if (waiting) {
      icon = '$(question)';
      state = `${waiting} input`;
    }
    this.status.text = `${icon} JF ${this.windowInstanceId.slice(0, 8)} · ${state}`;
    this.status.command = waiting ? 'jobFinish.respond' : 'jobFinish.results';
    this.status.tooltip = 'Job-Finish · automatic notifications · Settings: Job-Finish Enabled · Show Results';
  }

  private showDiagnostics(): void {
    this.output.clear();
    this.output.appendLine(JSON.stringify(this.api.snapshot(), (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
    this.output.show();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.notifications.dispose();
    this.sessions.dispose();
  }
}

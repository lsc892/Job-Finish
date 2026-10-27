import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Session } from './core/session';
import { Diagnostics, InputRequest, Provider, SessionBinding, Signal } from './core/model';
import { Lease, Ownership } from './core/ownership';
import { Notifications } from './core/notifications';
import type { AgentExecution } from './runtime/agent-provider';
import { agentProviders } from './runtime/providers';
import { AgentStreamObserver, AgentRoot } from './runtime/observe';
import { Win32, WindowIdentity } from './windows/native';
import { FlashController } from './windows/flash';
import { WindowsToast } from './windows/toast';

interface Entry { provider: Provider; cwd: string; session: Session; lease: Lease; execution: AgentExecution }
interface SavedSession { provider: Provider; cwd: string; sessionId: string }
let active: Application | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  if (process.platform !== 'win32' || vscode.env.remoteName) {
    const output = vscode.window.createOutputChannel('Job-Finish'); context.subscriptions.push(output);
    output.appendLine('Job-Finish requires a local Windows desktop VS Code window.'); return;
  }
  active = new Application(context); await active.activate(); return active.api;
}
export function deactivate(): void { active?.dispose(); active = undefined; }

class Application {
  readonly windowInstanceId = randomUUID();
  private readonly diagnostics = new Diagnostics(entry => this.output.appendLine(JSON.stringify(entry)));
  private readonly entries = new Map<string, Entry>();
  private readonly output = vscode.window.createOutputChannel('Job-Finish');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private readonly ownership: Ownership;
  private native?: Win32;
  private identity?: WindowIdentity;
  private flash?: FlashController;
  private toast: WindowsToast;
  private notifications: Notifications;
  private observer: AgentStreamObserver;
  private disposed = false;
  private opening = 0;
  private readonly busy = new Set<string>();
  constructor(private context: vscode.ExtensionContext) {
    this.toast = new WindowsToast(WindowsToast.binary(context.extensionPath), this.diagnostics);
    const storage = context.extensionMode === vscode.ExtensionMode.Test && process.env.JOB_FINISH_TEST_SHARED_STORAGE
      ? process.env.JOB_FINISH_TEST_SHARED_STORAGE : context.globalStorageUri.fsPath;
    mkdirSync(storage, { recursive: true });
    this.ownership = new Ownership(storage);
    this.observer = new AgentStreamObserver(this.windowInstanceId, () => this.agentRoots(), signal => this.onSignal(signal),
      this.diagnostics, (provider, id) => this.entries.get(id)?.provider === provider);
    try {
      this.native = new Win32();
      this.identity = new WindowIdentity(this.windowInstanceId, this.native, () => vscode.window.state.focused, process.execPath, this.diagnostics);
      this.flash = new FlashController(this.native, () => vscode.window.state.focused);
    } catch (e) { this.diagnostics.add(`Native flash unavailable: ${e}`); }
    this.notifications = new Notifications({
      enabled: () => this.config('enabled', true),
      focused: () => vscode.window.state.focused,
      owns: signal => this.owns(signal),
      stopFlash: id => this.flash?.stop(id),
      activate: signal => { this.diagnostics.trace('notification.click.handled', { notificationId: signal.notificationId, windowInstanceId: this.windowInstanceId }); },
      flash: signal => {
        const binding = this.identity?.valid();
        if (this.config('flash', true) && binding) this.flash?.start(binding, signal.notificationId, this.config('flashMode', 'manual'), this.config('flashTimeoutSeconds', 300) * 1000);
      },
      toast: async (signal, message, click, allowed) => {
        const binding = this.identity?.valid();
        if (this.config('toast', true)) await this.toast.show({ notificationId: signal.notificationId, windowInstanceId: this.windowInstanceId,
          title: `${signal.provider} · ${signal.status} · ${this.windowInstanceId.slice(0, 8)}`, message, appId: WindowsToast.appId, onClick: click,
          target: binding ? { hwnd: binding.hwnd.toString(), pid: binding.pid, executable: binding.executable } : undefined,
          canActivate: () => !this.disposed && this.config('enabled', true) && this.owns(signal) }, allowed);
      },
    });
  }
  get api() { return {
    identity: () => ({ windowInstanceId: this.windowInstanceId, vscodeSessionId: vscode.env.sessionId, extensionHostPid: process.pid, workspaceUris: vscode.workspace.workspaceFolders?.map(f => f.uri.toString()) ?? [] }),
    snapshot: () => ({ enabled: this.config('enabled', true), automatic: this.observer.snapshot(), results: this.notifications.results, sessions: [...this.entries.values()].map(e => ({ binding: e.session.binding, state: e.session.checkpoint(), pending: e.session.requests.size })), diagnostics: this.diagnostics.entries, events: this.diagnostics.events, native: this.identity?.binding }),
    // The same product path is available to Extension Host tests without automating prompt UI.
    ...(this.context.extensionMode === vscode.ExtensionMode.Test ? {
      test: {
        open: (provider: Provider, cwd: string, sessionId?: string) => this.open(provider, cwd, sessionId).then(e => e.session.binding.sessionId),
        run: (sessionId: string, prompt: string) => this.entries.get(sessionId)!.execution.run(prompt),
        cancel: (sessionId: string) => this.entries.get(sessionId)!.execution.cancel(),
        release: (sessionId: string) => this.detach(this.entries.get(sessionId)!),
        bind: () => this.identity?.observe(),
        flashId: () => this.flash?.activeNotificationId,
        unbind: () => { if (this.identity) this.identity.binding = undefined; },
      },
    } : {}),
  }; }
  private config<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('jobFinish').get<T>(key, fallback); }
  private owns(signal: Signal): boolean {
    return signal.source === 'verifiedIntegration' ? this.observer.owns(signal) : this.entries.get(signal.sessionId)?.lease.valid() === true;
  }
  private agentRoots(): AgentRoot[] {
    if (this.context.extensionMode === vscode.ExtensionMode.Test && process.env.JOB_FINISH_TEST_AGENT_ROOT) {
      return agentProviders.all().map(provider => ({ provider: provider.id, path: process.env.JOB_FINISH_TEST_AGENT_ROOT! }));
    }
    return agentProviders.all().flatMap(provider => {
      const extension = vscode.extensions.getExtension(provider.extensionId); return extension ? [{ provider: provider.id, path: extension.extensionPath }] : [];
    });
  }
  private configureNotifications(): void {
    if (this.config('enabled', true) && this.config('toast', true)) void this.toast.initialize().catch(error => this.diagnostics.add(error));
    if (this.config('enabled', true)) this.observer.start();
    else { this.observer.stop(); this.flash?.stop(); this.toast.stop(); }
    if (!this.config('toast', true)) this.toast.stop();
    if (!this.config('flash', true)) this.flash?.stop();
    this.updateStatus();
  }
  async activate(): Promise<void> {
    this.configureNotifications();
    this.status.command = 'jobFinish.results'; this.updateStatus(); this.status.show();
    const commands: Record<string, () => unknown> = {
      continue: () => this.withEntry(async e => { const prompt = await this.prompt(); if (prompt) await e.execution.run(prompt); }),
      resume: () => this.resume(), cancel: () => this.withEntry(e => e.execution.cancel()),
      reconnect: () => this.withEntry(e => e.execution.reconnect()), respond: () => this.respond(),
      detach: () => this.withEntry(e => this.detach(e)), results: () => this.results(),
      bindWindow: async () => {
        if (!await this.identity?.observe()) throw new Error('Could not verify a stable focused Code window. Focus this window and retry.');
        void vscode.window.showInformationMessage(`Job-Finish: window ${this.windowInstanceId.slice(0, 8)} connected.`);
      },
      stopFlash: () => this.flash?.stop(), diagnostics: () => {
        this.output.clear(); this.output.appendLine(JSON.stringify(this.api.snapshot(), (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2)); this.output.show();
      },
    };
    for (const provider of agentProviders.all()) commands[provider.runCommand] = () => this.runNew(provider.id);
    for (const [name, handler] of Object.entries(commands)) this.context.subscriptions.push(vscode.commands.registerCommand(`jobFinish.${name}`, async () => {
      try { await handler(); } catch (e) { this.report(e); } finally { this.updateStatus(); }
    }));
    this.context.subscriptions.push(this.output, this.status, vscode.window.onDidChangeWindowState(state => {
      this.diagnostics.trace('window.focus', { windowInstanceId: this.windowInstanceId, focused: state.focused, foreground: this.native?.foreground().toString() });
      this.identity?.changed();
      if (state.focused) { this.flash?.stop(); void this.identity?.observe().catch(e => this.diagnostics.add(e)); }
    }), vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('jobFinish')) this.configureNotifications();
    }), { dispose: () => this.dispose() });
    // Initial Extension Host focus state can precede the first real window-state event.
    await this.identity?.observe(750);
  }
  private async prompt(): Promise<string | undefined> {
    return vscode.window.showInputBox({ title: 'Job-Finish · Agent task', prompt: 'Run in this workspace. Tool approvals will appear in Answer Pending Request.', ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : 'Enter a task' });
  }
  private async cwd(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1) return folders[0]!.uri.fsPath;
    if (folders?.length) return (await vscode.window.showWorkspaceFolderPick())?.uri.fsPath;
    return (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Agent working directory' }))?.[0]?.fsPath;
  }
  private async runNew(provider: Provider): Promise<void> {
    const cwd = await this.cwd(); if (!cwd) return;
    const prompt = await this.prompt(); if (!prompt) return;
    const entry = await this.open(provider, cwd); await entry.execution.run(prompt);
  }
  private async open(provider: Provider, cwd: string, sessionId?: string): Promise<Entry> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before running an agent');
    if (this.entries.size + this.opening >= this.config('maxSessions', 8) || this.entries.size + this.opening >= this.config('maxConnections', 4)) throw new Error('Session/connection limit reached. Release an existing session first.');
    if (sessionId && this.entries.has(sessionId)) throw new Error('Session is already connected in this window');
    const implementation = agentProviders.get(provider);
    this.opening++;
    let lease: Lease | undefined; let execution: AgentExecution | undefined;
    let entry: Entry | undefined;
    const createSession = (id: string, connectionId: string): Session => {
      if (this.disposed) throw new Error('Extension deactivated');
      const binding: SessionBinding = { windowInstanceId: this.windowInstanceId, provider, runtimeId: implementation.runtimeId(), connectionId, sessionId: id, source: 'ownedExecution' };
      lease = this.ownership.claim(binding);
      const session = new Session(binding, () => lease!.valid(), state => lease!.save(state), signal => this.onSignal(signal), this.diagnostics, lease.load(), () => this.updateStatus());
      // Register before a connected runtime can reconcile and emit a result.
      if (execution) { entry = { provider, cwd, session, lease, execution }; this.entries.set(id, entry); }
      return session;
    };
    try {
      execution = implementation.createExecution({ cwd, sessionId, diagnostics: this.diagnostics,
        config: (key, fallback) => this.config(key, fallback), createSession });
      if (execution.open) await execution.open(sessionId);
      const session = execution.session;
      if (!session) throw new Error(`Agent provider ${provider} did not create a session`);
      entry = { provider, cwd, session, lease: lease!, execution }; this.entries.set(session.binding.sessionId, entry);
      const saved = this.context.workspaceState.get<SavedSession[]>('sessions', []);
      const record = { provider, cwd, sessionId: session.binding.sessionId };
      await this.context.workspaceState.update('sessions', [...saved.filter(s => s.sessionId !== record.sessionId), record].slice(-32));
      this.updateStatus(); return entry;
    } catch (e) { execution?.dispose(); if (entry) this.entries.delete(entry.session.binding.sessionId); lease?.release(); throw e; }
    finally { this.opening--; }
  }
  private async resume(): Promise<void> {
    const saved = this.context.workspaceState.get<SavedSession[]>('sessions', []);
    const pick = await vscode.window.showQuickPick(saved.map(s => ({ label: `${s.provider} · ${s.sessionId}`, description: s.cwd, value: s })), { title: 'Resume a Job-Finish session (history does not trigger notifications)' });
    if (pick) await this.open(pick.value.provider, pick.value.cwd, pick.value.sessionId);
  }
  private async withEntry(fn: (entry: Entry) => unknown): Promise<void> {
    const pick = await vscode.window.showQuickPick([...this.entries.values()].map(e => ({ label: `${e.provider} · ${e.session.binding.sessionId}`, description: e.session.pendingStart ? 'unknown (start request)' : [...e.session.turns.values()].map(t => t.status).join(', ') || 'idle', value: e })), { title: 'Job-Finish session' });
    if (!pick) return;
    const id = pick.value.session.binding.sessionId;
    if (this.busy.has(id)) throw new Error('Another session command is in progress');
    this.busy.add(id); try { await fn(pick.value); } finally { this.busy.delete(id); }
  }
  private async respond(): Promise<void> {
    const requests = [...this.entries.values()].flatMap(entry => [...entry.session.requests.values()].map(request => ({ label: `${entry.provider} · ${request.kind}`, description: request.title.slice(0, 180), entry, request })));
    const pick = await vscode.window.showQuickPick(requests, { title: 'Pending agent request', ignoreFocusOut: true });
    if (!pick) return;
    const result = await this.answer(pick.entry, pick.request);
    if (result !== undefined) pick.entry.execution.respond(pick.request.id, result);
  }
  private async answer(entry: Entry, request: InputRequest): Promise<unknown> {
    return agentProviders.get(entry.provider).answer(request, {
      showRequest: async payload => {
        const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(payload, null, 2), language: 'json' });
        await vscode.window.showTextDocument(doc, { preview: true });
      },
      approve: async title => {
        const answer = await vscode.window.showQuickPick(['Deny', 'Allow once'], { title, ignoreFocusOut: true });
        return answer === undefined ? undefined : answer === 'Allow once';
      },
      question: (question, options, settings) => this.question(question, options, settings),
    });
  }
  private async question(question: string, options: { label: string; description?: string }[],
    { multiSelect, secret }: { multiSelect: boolean; secret: boolean }): Promise<string[] | undefined> {
    if (options.length && !secret) {
      const custom = { label: 'Write an answer…', description: '' };
      const picks = await vscode.window.showQuickPick([...options, custom], { title: question, canPickMany: multiSelect, ignoreFocusOut: true });
      if (!picks) return;
      const list = Array.isArray(picks) ? picks : [picks];
      if (!list.some(item => item === custom)) return list.map(item => item.label);
    }
    const text = await vscode.window.showInputBox({ title: question, password: secret, ignoreFocusOut: true });
    return text === undefined ? undefined : [text];
  }
  private async results(): Promise<void> {
    const signals = [...this.notifications.results].reverse();
    const choice = await vscode.window.showQuickPick(signals.map(s => ({ label: `${s.provider} · ${s.status}`, description: `${s.at} · ${s.sessionId}`, detail: s.text.slice(0, 120), value: s })), { title: 'Recent results (up to 20)' });
    if (!choice) return;
    const s = choice.value; let text = s.text;
    let note = '';
    if (s.truncated) {
      try { const full = await this.entries.get(s.sessionId)?.execution.readResult(s.turnId); if (full) text = full; else note = '\n\n[Saved result truncated to 16 KiB; full result unavailable.]'; }
      catch (e) { note = `\n\n[Saved result truncated; full result retrieval failed: ${e}]`; }
    }
    const doc = await vscode.workspace.openTextDocument({ content: `${s.provider} · ${s.status}\nWindow: ${s.windowInstanceId}\nSession: ${s.sessionId}\nTurn: ${s.turnId}\n\n${text || '[No final response body received]'}${note}${s.detail ? '\n\n' + s.detail : ''}`, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
  private onSignal(signal: Signal): void {
    this.diagnostics.trace('signal.received', { windowInstanceId: signal.windowInstanceId, notificationId: signal.notificationId,
      provider: signal.provider, status: signal.status, owned: this.owns(signal), focused: vscode.window.state.focused });
    void this.notifications.deliver(signal).catch(e => this.diagnostics.add(e)); this.updateStatus();
  }
  private updateStatus(): void {
    const waiting = [...this.entries.values()].reduce((n, e) => n + e.session.requests.size, 0);
    this.status.text = `${!this.config('enabled', true) ? '$(bell-slash)' : waiting ? '$(question)' : '$(bell)'} JF ${this.windowInstanceId.slice(0, 8)} · ${!this.config('enabled', true) ? 'off' : waiting ? `${waiting} input` : 'on'}`;
    this.status.command = waiting ? 'jobFinish.respond' : 'jobFinish.results';
    this.status.tooltip = 'Job-Finish · automatic notifications · Settings: Job-Finish Enabled · Show Results';
  }
  private detach(entry: Entry): void {
    try { entry.execution.dispose(); }
    finally {
      try { entry.lease.release(); }
      finally { this.entries.delete(entry.session.binding.sessionId); this.flash?.stop(); }
    }
  }
  private report(error: unknown): void { this.diagnostics.add(error); void vscode.window.showErrorMessage(`Job-Finish: ${error}`); }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.observer.dispose();
    this.flash?.dispose(); this.identity?.dispose(); this.toast.dispose();
    for (const entry of [...this.entries.values()]) { try { this.detach(entry); } catch (e) { this.diagnostics.add(e); } }
    this.entries.clear();
  }
}

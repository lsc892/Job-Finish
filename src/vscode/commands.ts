// 세션 실행·복구·입력 응답 명령을 등록하고 사용자 입력 동안 세션 명령을 직렬화한다.
import * as vscode from 'vscode';
import type { ApplicationSession, ApplicationSessions } from '../application/sessions';
import type { Provider } from '../core/model';
import { agentProviders } from '../runtime/providers';
import { AgentInput } from './interaction';

type Command = () => unknown;
interface CommandPorts {
  results(): Promise<void>;
  bindWindow(): Promise<void>;
  stopFlash(): void;
  diagnostics(): void;
  report(error: unknown): void;
  changed(): void;
}

/** 세션 명령을 등록하고 사용자 입력을 기다리는 동안 같은 세션의 명령 중복을 막는다. */
export class SessionCommands {
  private readonly busy = new Set<string>();

  constructor(private readonly sessions: ApplicationSessions, private readonly input: AgentInput,
    private readonly ports: CommandPorts) {}

  register(subscriptions: vscode.Disposable[]): void {
    const commands: Record<string, Command> = {
      continue: () => this.withEntry(async entry => {
        const prompt = await this.input.prompt();
        if (prompt) await entry.execution.run(prompt);
      }),
      resume: () => this.resume(),
      cancel: () => this.withEntry(entry => entry.execution.cancel()),
      reconnect: () => this.withEntry(entry => entry.execution.reconnect()),
      respond: () => this.respond(),
      detach: () => this.withEntry(entry => this.sessions.detach(entry)),
      results: () => this.ports.results(),
      bindWindow: () => this.ports.bindWindow(),
      stopFlash: () => this.ports.stopFlash(),
      diagnostics: () => this.ports.diagnostics(),
    };
    for (const provider of agentProviders.all()) commands[provider.runCommand] = () => this.runNew(provider.id);
    for (const [name, handler] of Object.entries(commands)) {
      subscriptions.push(vscode.commands.registerCommand(`jobFinish.${name}`, async () => {
        try { await handler(); }
        catch (error) { this.ports.report(error); }
        finally { this.ports.changed(); }
      }));
    }
  }

  private async runNew(provider: Provider): Promise<void> {
    const cwd = await this.input.cwd();
    if (!cwd) return;
    const prompt = await this.input.prompt();
    if (!prompt) return;
    const entry = await this.sessions.open(provider, cwd);
    await entry.execution.run(prompt);
  }

  private async resume(): Promise<void> {
    const saved = this.sessions.saved();
    const pick = await vscode.window.showQuickPick(saved.map(session => ({ label: `${session.provider} · ${session.sessionId}`, description: session.cwd, value: session })), { title: 'Resume a Job-Finish session (history does not trigger notifications)' });
    if (pick) await this.sessions.open(pick.value.provider, pick.value.cwd, pick.value.sessionId);
  }

  private async withEntry(action: (entry: ApplicationSession) => unknown): Promise<void> {
    const pick = await vscode.window.showQuickPick([...this.sessions.values()].map(entry => ({ label: `${entry.provider} · ${entry.session.binding.sessionId}`, description: entry.session.pendingStart ? 'unknown (start request)' : [...entry.session.turns.values()].map(turn => turn.status).join(', ') || 'idle', value: entry })), { title: 'Job-Finish session' });
    if (!pick) return;
    const id = pick.value.session.binding.sessionId;
    if (this.busy.has(id)) throw new Error('Another session command is in progress');
    this.busy.add(id);
    try { await action(pick.value); }
    finally { this.busy.delete(id); }
  }

  private async respond(): Promise<void> {
    const requests = [...this.sessions.values()].flatMap(entry => [...entry.session.requests.values()].map(request => ({ label: `${entry.provider} · ${request.kind}`, description: request.title.slice(0, 180), entry, request })));
    const pick = await vscode.window.showQuickPick(requests, { title: 'Pending agent request', ignoreFocusOut: true });
    if (!pick) return;
    const result = await this.input.answer(pick.entry, pick.request);
    if (result !== undefined) pick.entry.execution.respond(pick.request.id, result);
  }
}

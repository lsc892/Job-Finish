import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Diagnostics, InputRequest, Provider } from '../core/model';
import type { Session } from '../core/session';

/** Common execution contract; providers may connect lazily or during open. */
export interface AgentExecution {
  readonly session?: Session;
  open?(sessionId?: string): Promise<void>;
  run(prompt: string): Promise<void>;
  cancel(): Promise<void>;
  reconnect(): Promise<void>;
  respond(requestId: string, result: unknown): void;
  readResult(turnId: string): Promise<string | undefined>;
  dispose(): void;
}

export interface ExecutionContext {
  cwd: string;
  sessionId?: string;
  diagnostics: Diagnostics;
  config<T>(key: string, fallback: T): T;
  createSession(sessionId: string, connectionId: string): Session;
}

/** Connection-local parsing state belongs to the handler, not the shared provider. */
export interface AgentEvents {
  incoming(message: Record<string, unknown>): void;
  outgoing(message: Record<string, unknown>): void;
  dispose(): void;
}
export interface EventContext {
  readonly connectionId: string;
  session(id: string): Session | undefined;
  existingSession(id: string): Session | undefined;
}

export interface QuestionOptions { multiSelect: boolean; secret: boolean }
export interface AgentInteraction {
  showRequest(payload: unknown): Promise<void>;
  approve(title: string): Promise<boolean | undefined>;
  question(question: string, options: { label: string; description?: string }[], settings: QuestionOptions): Promise<string[] | undefined>;
}

/** Add a subclass and register it in providers/index.ts to support another agent. */
export abstract class AgentProvider {
  abstract readonly id: Provider;
  abstract readonly extensionId: string;
  abstract readonly runCommand: string;
  abstract matchesProcess(args: readonly string[]): boolean;
  abstract runtimeDirectory(): string;
  abstract createEvents(context: EventContext): AgentEvents;
  abstract createExecution(context: ExecutionContext): AgentExecution;
  protected abstract approvalResponse(request: InputRequest, allow: boolean): unknown;
  protected abstract answerQuestions(request: InputRequest, interaction: AgentInteraction): Promise<unknown>;

  runtimeId(): string {
    const directory = this.runtimeDirectory();
    const canonical = existsSync(directory) ? realpathSync.native(directory) : resolve(directory);
    return createHash('sha256').update(JSON.stringify([this.id, process.platform === 'win32' ? canonical.toLowerCase() : canonical])).digest('hex');
  }

  async answer(request: InputRequest, interaction: AgentInteraction): Promise<unknown> {
    if (request.kind === 'question') return this.answerQuestions(request, interaction);
    // Display the complete bounded request before asking for approval.
    await interaction.showRequest(request.payload);
    const allow = await interaction.approve(request.title.slice(0, 150));
    if (allow === undefined) return;
    return this.approvalResponse(request, allow);
  }
}

export class AgentProviderRegistry {
  private readonly providers = new Map<Provider, AgentProvider>();
  constructor(providers: readonly AgentProvider[]) {
    const commands = new Set<string>();
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`Duplicate agent provider: ${provider.id}`);
      if (commands.has(provider.runCommand)) throw new Error(`Duplicate agent command: ${provider.runCommand}`);
      this.providers.set(provider.id, provider); commands.add(provider.runCommand);
    }
  }
  all(): readonly AgentProvider[] { return [...this.providers.values()]; }
  get(id: Provider): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unsupported agent provider: ${id}`);
    return provider;
  }
  match(args: readonly string[]): AgentProvider | undefined { return this.all().find(provider => provider.matchesProcess(args)); }
}

// 제공자별 실행·관찰·입력 응답 계약과 제공자 등록·조회 기능을 정의한다.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Diagnostics, InputRequest, Provider } from '../core/model';
import type { Session } from '../core/session';
import type { AgentExecution } from './execution';
export type { AgentExecution } from './execution';

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

// Add a runtime folder and register its provider in providers.ts to support another agent.
/** 제공자별 실행·관찰 생성과 사용자 승인·질문 응답의 공통 계약을 제공한다. */
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

/** 중복 없는 제공자·명령 등록을 검증하고 식별자·프로세스 인자로 제공자를 조회한다. */
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

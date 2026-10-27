import type { Session } from '../core/session';

/** Structural contract shared by built-in runtimes and independently registered providers. */
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

export interface RuntimeOptions<TEvent> {
  cwd: string;
  executable?: string;
  model?: string;
  onEvent?: (message: TEvent) => void;
}

/** Shares ownership validation while each runtime retains its own connection and recovery policy. */
export abstract class AgentRuntime implements AgentExecution {
  abstract readonly session: Session | undefined;
  abstract run(prompt: string): Promise<void>;
  abstract cancel(): Promise<void>;
  abstract reconnect(): Promise<void>;
  abstract respond(requestId: string, result: unknown): void;
  abstract readResult(turnId: string): Promise<string | undefined>;
  abstract dispose(): void;

  protected assertOwnership(): void {
    if (!this.session?.valid(this.session.binding.connectionId)) throw new Error('Session ownership lost');
  }
}

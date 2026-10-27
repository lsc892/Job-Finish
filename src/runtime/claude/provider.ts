// Claude 실행·관찰 구성과 승인·질문 응답을 공통 제공자 계약에 연결한다.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InputRequest } from '../../core/model';
import { AgentProvider } from '../agent-provider';
import type { AgentEvents, AgentInteraction, EventContext, ExecutionContext } from '../agent-provider';
import { ClaudeExecution } from './execution';
import { ClaudeEvents } from './events';

/** Claude 프로세스 식별·실행·관찰 생성과 승인·질문 응답을 제공한다. */
export class ClaudeProvider extends AgentProvider {
  readonly id = 'claude';
  readonly extensionId = 'anthropic.claude-code';
  readonly runCommand = 'runClaude';
  matchesProcess(args: readonly string[]): boolean {
    return args.some((arg, i) => arg === '--output-format=stream-json' || arg === '--output-format' && args[i + 1] === 'stream-json');
  }
  runtimeDirectory(): string { return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'); }
  createEvents(context: EventContext): AgentEvents { return new ClaudeEvents(context); }
  createExecution(context: ExecutionContext): ClaudeExecution {
    const session = context.createSession(context.sessionId ?? randomUUID(), randomUUID());
    return new ClaudeExecution({ cwd: context.cwd, executable: context.config('claudeExecutable', ''),
      maxTurns: context.config('claudeMaxTurns', 50), session, resume: !!context.sessionId });
  }
  protected approvalResponse(request: InputRequest, allow: boolean): unknown {
    if (allow) return { behavior: 'allow', updatedInput: (request.payload as { input: unknown }).input };
    return { behavior: 'deny', message: 'Denied by user' };
  }
  protected async answerQuestions(request: InputRequest, interaction: AgentInteraction): Promise<unknown> {
    const payload = request.payload as { input: { questions?: { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] } };
    const claudeAnswers: Record<string, string> = {};
    if (!payload.input.questions?.length) throw new Error('Unsupported Claude question schema');
    for (const q of payload.input.questions) {
      const answer = await interaction.question(q.question, q.options ?? [], { multiSelect: !!q.multiSelect, secret: false });
      if (!answer) return;
      claudeAnswers[q.question] = answer.join(', ');
    }
    return { behavior: 'allow', updatedInput: { ...payload.input, answers: claudeAnswers } };
  }
}

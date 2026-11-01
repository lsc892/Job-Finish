// Codex 실행·관찰 구성과 승인·질문 응답을 공통 제공자 계약에 연결한다.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InputRequest } from '../../core/model';
import type { ToolRequestUserInputParams } from '../../protocol/v2/ToolRequestUserInputParams';
import { AgentProvider } from '../agent-provider';
import type { AgentEvents, AgentInteraction, EventContext, ExecutionContext } from '../agent-provider';
import { CodexExecution } from './execution';
import { codexApprovalResponse } from './adapter';
import type { RpcMessage } from '../transport';
import { CodexEvents } from './events';

/** Codex 프로세스 식별·실행·관찰 생성과 승인·질문 응답을 제공한다. */
export class CodexProvider extends AgentProvider {
  readonly id = 'codex';
  readonly extensionId = 'openai.chatgpt';
  readonly runCommand = 'runCodex';
  matchesProcess(args: readonly string[]): boolean { return args.includes('app-server'); }
  runtimeDirectory(): string { return process.env.CODEX_HOME ?? join(homedir(), '.codex'); }
  createEvents(context: EventContext): AgentEvents { return new CodexEvents(context); }
  createExecution(context: ExecutionContext): CodexExecution {
    return new CodexExecution({ cwd: context.cwd, executable: context.config('codexExecutable', ''),
      model: context.config('codexModel', '') || undefined, mode: context.config('codexMode', 'default'),
      diagnostic: context.diagnostics, createSession: context.createSession });
  }
  protected approvalResponse(request: InputRequest, allow: boolean): unknown {
    return codexApprovalResponse(request.payload as RpcMessage, allow);
  }
  protected async answerQuestions(request: InputRequest, interaction: AgentInteraction): Promise<unknown> {
    const answers: Record<string, { answers: string[] }> = {};
    const params = (request.payload as RpcMessage).params as ToolRequestUserInputParams;
    for (const q of params.questions) {
      const answer = await interaction.question(q.question, q.options ?? [], { multiSelect: false, secret: q.isSecret });
      if (!answer) return;
      answers[q.id] = { answers: answer };
    }
    return { answers };
  }
}

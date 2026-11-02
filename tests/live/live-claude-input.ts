// 실제 Claude SDK의 질문·승인·취소·턴 제한 경로를 임시 작업 공간에서 검증한다.
// Opt-in actual SDK checks. Tool access is restricted to one question or one file in an owned temporary directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CanUseTool, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk' with { "resolution-mode": "import" };
import { ClaudeExecution } from '../../src/runtime/claude';
import { Diagnostics, InputRequest, Signal } from '../../src/core/model';
import { Session } from '../../src/core/session';
import { Lease, Ownership } from '../../src/core/ownership';
import { runtimeId } from '../../src/runtime/providers';

class ClaudeInputProbe {
  private readonly diagnostics = new Diagnostics();
  private readonly signals: Signal[] = [];
  private readonly events: SDKMessage[] = [];
  private readonly requests: unknown[] = [];
  private readonly lease: Lease;
  private readonly session: Session;
  private readonly execution: ClaudeExecution;
  private readonly target: string;
  private handled = false;

  constructor(private readonly scenario: string, root: string, owner: Ownership, createQuery: typeof query) {
    this.target = join(root, `${scenario}.txt`);
    const binding = { provider: 'claude', runtimeId: runtimeId('claude'), sessionId: randomUUID(),
      connectionId: randomUUID(), windowInstanceId: randomUUID(), source: 'ownedExecution' as const };
    this.lease = owner.claim(binding);
    this.session = new Session(binding, () => this.lease.valid(), state => this.lease.save(state),
      signal => this.signals.push(signal), this.diagnostics);
    this.execution = new ClaudeExecution({
      cwd: root, maxTurns: this.scenario === 'turn-limit' ? 1 : 4, session: this.session, resume: false,
      onEvent: message => {
        if (message.type === 'result' || message.type === 'rate_limit_event') this.events.push(message);
      },
      createQuery: args => createQuery({ ...args, options: {
        ...args.options, settingSources: [], tools: [this.isQuestion ? 'AskUserQuestion' : 'Write'],
        canUseTool: this.recordRequests(args.options!.canUseTool!),
      } }),
    });
  }

  private get isQuestion(): boolean { return this.scenario === 'question' || this.scenario === 'cancel'; }

  async run(): Promise<unknown> {
    try {
      await this.execution.run(this.prompt());
      await this.waitForCompletion();
      assert.equal(this.handled, true, 'Actual SDK control request must be observed');
      const expected = this.scenario === 'cancel' ? 'cancelled' : this.scenario === 'turn-limit' ? 'error' : 'completed';
      assert.equal(this.signals.at(-1)!.status, expected);
      assert.equal(this.session.requests.size, 0);
      if (!this.isQuestion) assert.equal(readFileSync(this.target, 'utf8'), 'JOB_FINISH_APPROVAL_OK');
      if (this.scenario === 'turn-limit') assert.ok(this.events.some(event => 'subtype' in event && event.subtype === 'error_max_turns'));
      console.log(JSON.stringify({ scenario: this.scenario, passed: true, status: this.signals.at(-1)!.status, inputRequests: this.requests.length }));
      return { scenario: this.scenario, passed: true, signals: this.signals, requests: this.requests, events: this.events };
    } catch (error) {
      console.error(`${this.scenario}: ${error}`);
      process.exitCode = 1;
      return { scenario: this.scenario, passed: false, error: String(error), signals: this.signals,
        requests: this.requests, events: this.events, diagnostics: this.diagnostics.entries };
    } finally {
      this.execution.dispose();
      this.lease.release();
    }
  }

  private recordRequests(canUseTool: CanUseTool): CanUseTool {
    return async (tool, input, options) => {
      this.requests.push({ tool, input, requestId: options.requestId, toolUseID: options.toolUseID });
      return canUseTool(tool, input, options);
    };
  }

  private prompt(): string {
    if (this.isQuestion) {
      return 'This is a bounded integration test. You must call AskUserQuestion exactly once to ask which color to use, with Blue and Green choices. Do not answer the question yourself. After the user answers, reply with JOB_FINISH_INPUT_OK and the chosen color. Do not use other tools or background tasks.';
    }
    return `This is a bounded integration test. Use Write exactly once to write the exact text JOB_FINISH_APPROVAL_OK to this temporary file: ${this.target}. Do not use other tools, read other files, or start background tasks. Then reply JOB_FINISH_INPUT_OK.`;
  }

  private async waitForCompletion(): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (!this.signals.some(signal => signal.status !== 'waitingForInput')) {
      if (Date.now() > deadline) throw new Error('Actual SDK input test timed out');
      const pending = [...this.session.requests.values()][0];
      if (pending && !this.handled) {
        this.handled = true;
        await this.handleRequest(pending);
      }
      if ([...this.session.turns.values()].some(turn => turn.status === 'unknown')) throw new Error('SDK execution became unknown');
      await delay(50);
    }
  }

  private async handleRequest(request: InputRequest): Promise<void> {
    // 취소는 SDK 확인을 기다리고 질문·쓰기 요청은 도구와 입력을 검증한 뒤 응답한다.
    if (this.scenario === 'cancel') {
      await this.execution.cancel();
      return;
    }
    if (this.isQuestion) {
      const { toolName, input } = request.payload as { toolName: string; input: Record<string, unknown> };
      assert.equal(toolName, 'AskUserQuestion');
      const questions = input.questions as { question: string }[];
      const answers = Object.fromEntries(questions.map(question => [question.question, 'Blue']));
      this.execution.respond(request.id, { behavior: 'allow', updatedInput: { ...input, answers } });
    } else {
      const { toolName, input } = request.payload as { toolName: string; input: Record<string, unknown> };
      assert.equal(toolName, 'Write');
      assert.equal(input.file_path, this.target);
      assert.equal(input.content, 'JOB_FINISH_APPROVAL_OK');
      this.execution.respond(request.id, { behavior: 'allow', updatedInput: input });
    }
  }
}

function saveReports(root: string, reports: unknown[]): void {
  mkdirSync('test-artifacts', { recursive: true });
  const file = `test-artifacts/claude-input-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tempWorkspace: root, reports }, null, 2));
  console.log(file);
}

async function main(): Promise<void> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(join(tmpdir(), 'job-finish-claude-input-'));
  const owner = new Ownership(root);
  const reports: unknown[] = [];
  const selected = process.argv.slice(2);
  const scenarios = selected.length ? selected : ['question', 'approval', 'cancel', 'turn-limit'];
  for (const scenario of scenarios) {
    reports.push(await new ClaudeInputProbe(scenario, root, owner, query).run());
  }
  saveReports(root, reports);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

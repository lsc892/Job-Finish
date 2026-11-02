// 실제 Codex App Server의 질문·승인·권한·취소와 재연결 경로를 검증한다.
// Opt-in App Server probes using the product transport, adapter, ownership and response path.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexExecution, codexApprovalResponse } from '../../src/runtime/codex';
import { Diagnostics, InputRequest, Signal } from '../../src/core/model';
import { Session } from '../../src/core/session';
import { Lease, Ownership } from '../../src/core/ownership';
import { runtimeId } from '../../src/runtime/providers';
import type { RpcMessage } from '../../src/runtime/transport';
import type { ToolRequestUserInputParams } from '../../src/protocol/v2/ToolRequestUserInputParams';

interface CodexInputReport {
  scenario: string;
  passed: boolean;
  signals: Signal[];
  events: RpcMessage[];
  replies: unknown[];
  error?: string;
  diagnostics?: Diagnostics['entries'];
}

class CodexInputProbe {
  private readonly diagnostics = new Diagnostics();
  private readonly signals: Signal[] = [];
  private readonly events: RpcMessage[] = [];
  private readonly replies: unknown[] = [];
  private readonly execution: CodexExecution;
  private lease?: Lease;
  private handled = false;

  constructor(private readonly scenario: string, private readonly root: string, private readonly owner: Ownership) {
    this.execution = new CodexExecution({
      cwd: root, executable: process.env.JOB_FINISH_LIVE_CODEX_EXECUTABLE,
      model: process.env.JOB_FINISH_LIVE_CODEX_MODEL, mode: this.isQuestion ? 'plan' : 'default',
      sandbox: 'read-only', permissionRequests: scenario === 'permissions', diagnostic: this.diagnostics,
      onEvent: message => this.recordEvent(message),
      createSession: (sessionId, connectionId) => this.createSession(sessionId, connectionId),
    });
  }

  private get isQuestion(): boolean { return this.scenario === 'question' || this.scenario === 'cancel'; }

  async run(): Promise<CodexInputReport> {
    try {
      await this.execution.open();
      await this.execution.run(this.prompt());
      await this.waitForCompletion();
      this.verifyCompletion();
      if (this.scenario !== 'cancel') await this.verifyStoredResult();
      await this.verifyReconnect();
      return this.successReport();
    } catch (error) {
      return this.failureReport(error);
    } finally {
      this.dispose();
    }
  }

  hasUsageLimit(): boolean {
    return this.events.some(event => event.method === 'turn/completed' &&
      (event.params as { turn?: { error?: { codexErrorInfo?: string } } })?.turn?.error?.codexErrorInfo === 'usageLimitExceeded');
  }

  private createSession(sessionId: string, connectionId: string): Session {
    const binding = { provider: 'codex', runtimeId: runtimeId('codex'), sessionId, connectionId,
      windowInstanceId: randomUUID(), source: 'ownedExecution' as const };
    const lease = this.owner.claim(binding);
    this.lease = lease;
    return new Session(binding, () => lease.valid(), state => lease.save(state), signal => this.signals.push(signal), this.diagnostics);
  }

  private recordEvent(message: RpcMessage): void {
    const method = message.method;
    if (!method) return;
    if (['turn/started', 'turn/completed', 'serverRequest/resolved', 'item/completed'].includes(method) ||
      method.endsWith('requestApproval') || method.endsWith('requestUserInput')) this.events.push(message);
  }

  private prompt(): string {
    if (this.isQuestion) {
      return 'This is a bounded user-input integration test. Do not inspect files, use shell commands, browse, or start agents. Use request_user_input exactly once to ask which color to use, offering Blue and Green. You must wait for that tool response. After the response, reply JOB_FINISH_CODEX_INPUT_OK and the chosen color. No further questions or implementation.';
    }
    if (this.scenario === 'permissions') {
      return `This is a bounded permissions integration test. Do not read any files, run commands, browse, or start agents. Use request_permissions exactly once to ask write permission for this single temporary directory: ${this.root}. Ask for no network access and no other paths. If denied, do not retry or write anything; reply JOB_FINISH_PERMISSION_DENIED. If allowed, reply JOB_FINISH_PERMISSION_ALLOWED without changing files.`;
    }
    return 'This is a bounded command approval integration test. Use the shell command tool exactly once to run Write-Output JOB_FINISH_APPROVAL_OK, explicitly requesting sandbox_permissions require_escalated with justification "May I print the integration-test marker?". This deliberately tests the approval handshake for a harmless stdout-only command. Do not read or change files, browse, use other commands, or start agents. If declined, do not retry; reply JOB_FINISH_APPROVAL_DENIED.';
  }

  private async waitForCompletion(): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (!this.signals.some(signal => signal.status !== 'waitingForInput')) {
      if (Date.now() > deadline) throw new Error('Codex input probe timed out');
      const pending = [...this.execution.session!.requests.values()][0];
      if (pending && !this.handled) {
        this.handled = true;
        await this.handleRequest(pending);
      }
      if ([...this.execution.session!.turns.values()].some(turn => turn.status === 'unknown')) throw new Error('Codex execution became unknown');
      await delay(50);
    }
  }

  private async handleRequest(request: InputRequest): Promise<void> {
    if (this.scenario === 'cancel') {
      await this.interrupt();
      return;
    }
    if (this.isQuestion) this.answerQuestion(request);
    else this.denyApproval(request);
  }

  private async interrupt(): Promise<void> {
    await this.execution.cancel();
    this.replies.push({ action: 'interrupt' });
  }

  private answerQuestion(request: InputRequest): void {
    assert.equal(request.kind, 'question');
    const params = (request.payload as RpcMessage).params as ToolRequestUserInputParams;
    const response = { answers: Object.fromEntries(params.questions.map(question => [question.id, { answers: ['Blue'] }])) };
    this.execution.respond(request.id, response);
    this.replies.push({ requestId: request.id, response });
  }

  private denyApproval(request: InputRequest): void {
    const message = request.payload as RpcMessage;
    assert.equal(message.method, this.scenario === 'permissions' ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval');
    const response = codexApprovalResponse(message, false);
    this.execution.respond(request.id, response);
    this.replies.push({ requestId: request.id, response });
  }

  private verifyCompletion(): void {
    assert.equal(this.handled, true, 'Must observe an actual input request');
    assert.equal(this.signals.at(-1)!.status, this.scenario === 'cancel' ? 'cancelled' : 'completed');
    assert.equal(this.execution.session!.requests.size, 0);
  }

  private async verifyStoredResult(): Promise<void> {
    const terminal = this.signals.at(-1)!;
    assert.equal(await this.execution.readResult(terminal.turnId), terminal.text, 'Actual paged final result retrieval');
  }

  private async verifyReconnect(): Promise<void> {
    const count = this.signals.length;
    await this.execution.reconnect();
    assert.equal(this.signals.length, count, 'No replay after actual reconnect');
  }

  private successReport(): CodexInputReport {
    console.log(JSON.stringify({ scenario: this.scenario, passed: true, status: this.signals.at(-1)!.status }));
    return { scenario: this.scenario, passed: true, signals: this.signals, events: this.events, replies: this.replies };
  }

  private failureReport(error: unknown): CodexInputReport {
    const reason = this.hasUsageLimit() ? 'Actual account usage limit reached; stopping further model probes' : error;
    console.error(`${this.scenario}: ${reason}`);
    process.exitCode = 1;
    return { scenario: this.scenario, passed: false, error: String(error), signals: this.signals,
      events: this.events, replies: this.replies, diagnostics: this.diagnostics.entries };
  }

  private dispose(): void {
    this.execution.dispose();
    this.lease?.release();
  }
}

function saveReports(root: string, reports: CodexInputReport[]): void {
  mkdirSync('test-artifacts', { recursive: true });
  const path = `test-artifacts/codex-input-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), tempWorkspace: root, reports }, null, 2));
  console.log(path);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-codex-input-'));
  const owner = new Ownership(root);
  const reports: CodexInputReport[] = [];
  const selected = process.argv.slice(2);
  const scenarios = selected.length ? selected : ['question', 'cancel', 'approval'];
  for (const scenario of scenarios) {
    const probe = new CodexInputProbe(scenario, root, owner);
    const report = await probe.run();
    reports.push(report);
    if (!report.passed && probe.hasUsageLimit()) break;
  }
  saveReports(root, reports);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

// 실제 Codex·Claude 실행의 완료 결과와 Codex 재연결 시 중복 알림 방지를 검증한다.
// Explicitly run by `npm run test:live`; never called by the offline test suite.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexExecution } from '../../src/runtime/codex';
import { ClaudeExecution } from '../../src/runtime/claude';
import { Diagnostics, SessionBinding, Signal } from '../../src/core/model';
import { Session } from '../../src/core/session';
import { Lease, Ownership } from '../../src/core/ownership';
import { runtimeId } from '../../src/runtime/providers';
import type { AgentExecution } from '../../src/runtime/execution';
import type { RpcMessage } from '../../src/runtime/transport';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk' with { "resolution-mode": "import" };

type LiveProvider = 'codex' | 'claude';
interface LiveRuntime {
  execution: AgentExecution;
  initialize?(): Promise<void>;
  verifyCompleted?(): Promise<void>;
}
const PROMPT = 'This is a connectivity test in an empty temporary directory. Do not use tools, read or write files, or start background tasks. Reply with exactly JOB_FINISH_LIVE_OK.';

class LiveProbe {
  private readonly signals: Signal[] = [];
  private readonly events: unknown[] = [];
  private readonly diagnostics = new Diagnostics();
  private readonly runtime: LiveRuntime;
  private lease?: Lease;

  constructor(private readonly provider: LiveProvider, root: string, private readonly owner: Ownership) {
    const factories = {
      codex: () => this.createCodexRuntime(root),
      claude: () => this.createClaudeRuntime(root),
    };
    this.runtime = factories[provider]();
  }

  async run(report: unknown[]): Promise<void> {
    try {
      await this.runtime.initialize?.();
      await this.runtime.execution.run(PROMPT);
      await this.waitForResult();
      this.recordSnapshot(report);
      this.logSummary();
      await this.verifyCompletion();
    } catch (error) {
      this.recordFailure(report, error);
    } finally {
      this.dispose();
    }
  }

  private createCodexRuntime(root: string): LiveRuntime {
    const execution = new CodexExecution({
      cwd: root, diagnostic: this.diagnostics,
      executable: process.env.JOB_FINISH_LIVE_CODEX_EXECUTABLE,
      model: process.env.JOB_FINISH_LIVE_CODEX_MODEL,
      createSession: (sessionId, connectionId) => this.createSession(sessionId, connectionId),
      onEvent: message => this.recordCodexEvent(message),
    });
    return { execution, initialize: () => execution.open(), verifyCompleted: () => this.verifyCodexReconnect(execution) };
  }

  private createClaudeRuntime(root: string): LiveRuntime {
    const execution = new ClaudeExecution({
      cwd: root, maxTurns: 2, resume: false,
      session: this.createSession(randomUUID(), randomUUID()),
      onEvent: message => this.recordClaudeEvent(message),
    });
    return { execution };
  }

  private createSession(sessionId: string, connectionId: string): Session {
    const binding: SessionBinding = { provider: this.provider, runtimeId: runtimeId(this.provider), sessionId,
      connectionId, windowInstanceId: randomUUID(), source: 'ownedExecution' };
    const lease = this.owner.claim(binding);
    this.lease = lease;
    return new Session(binding, () => lease.valid(), state => lease.save(state), signal => this.signals.push(signal), this.diagnostics);
  }

  private recordCodexEvent(message: RpcMessage): void {
    if (['turn/started', 'turn/completed', 'item/completed'].includes(message.method ?? '')) this.events.push(message);
  }

  private recordClaudeEvent(message: SDKMessage): void {
    if (message.type === 'result') this.events.push(message);
  }

  private hasResult(): boolean {
    return this.signals.some(signal => signal.status !== 'waitingForInput');
  }

  private isExecutionUnknown(): boolean {
    const turns = this.runtime.execution.session?.turns;
    return !!turns?.size && [...turns.values()].every(turn => turn.status === 'unknown');
  }

  private async waitForResult(): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (!this.hasResult() && Date.now() < deadline) {
      if (this.isExecutionUnknown()) return;
      await delay(250);
    }
  }

  private recordSnapshot(report: unknown[]): void {
    report.push({ provider: this.provider, signals: this.signals, events: this.events,
      diagnostics: this.diagnostics.entries, state: this.runtime.execution.session?.checkpoint() });
  }

  private logSummary(): void {
    const latest = this.signals.at(-1);
    console.log(JSON.stringify({ provider: this.provider, status: latest?.status ?? 'unknown',
      text: latest?.text, diagnostic: this.diagnostics.entries.at(-1)?.message }));
  }

  private async verifyCompletion(): Promise<void> {
    if (this.signals.at(-1)?.status !== 'completed') {
      process.exitCode = 1;
      return;
    }
    await this.runtime.verifyCompleted?.();
  }

  private async verifyCodexReconnect(execution: CodexExecution): Promise<void> {
    await execution.reconnect();
    if (this.signals.length !== 1) throw new Error('Historical result replayed after reconnection');
    console.log('Codex reconnect: no historical re-notification');
  }

  private recordFailure(report: unknown[], error: unknown): void {
    report.push({ provider: this.provider, error: String(error), diagnostics: this.diagnostics.entries });
    console.log(`${this.provider}: ${error}`);
    process.exitCode = 1;
  }

  private dispose(): void {
    this.runtime.execution.dispose();
    this.lease?.release();
  }
}

function selectedProviders(args: string[]): LiveProvider[] {
  const providers = args.filter((provider): provider is LiveProvider => provider === 'codex' || provider === 'claude');
  return providers.length ? providers : ['codex', 'claude'];
}

function saveReport(root: string, report: unknown[]): void {
  mkdirSync('test-artifacts', { recursive: true });
  writeFileSync(`test-artifacts/live-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), tempWorkspace: root, report }, null, 2));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-live-'));
  const owner = new Ownership(root);
  const report: unknown[] = [];
  for (const provider of selectedProviders(process.argv.slice(2))) {
    await new LiveProbe(provider, root, owner).run(report);
  }
  saveReport(root, report);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

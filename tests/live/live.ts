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
      codex: () => {
        const execution = new CodexExecution({
          cwd: root, diagnostic: this.diagnostics,
          executable: process.env.JOB_FINISH_LIVE_CODEX_EXECUTABLE,
          model: process.env.JOB_FINISH_LIVE_CODEX_MODEL,
          createSession: (sessionId, connectionId) => this.createSession(sessionId, connectionId),
          onEvent: message => {
            if (['turn/started', 'turn/completed', 'item/completed'].includes(message.method ?? '')) this.events.push(message);
          },
        });
        return {
          execution,
          initialize: () => execution.open(),
          verifyCompleted: async () => {
            await execution.reconnect();
            if (this.signals.length !== 1) throw new Error('Historical result replayed after reconnection');
            console.log('Codex reconnect: no historical re-notification');
          },
        };
      },
      claude: () => {
        const execution = new ClaudeExecution({
          cwd: root, maxTurns: 2, resume: false,
          session: this.createSession(randomUUID(), randomUUID()),
          onEvent: message => {
            if (message.type === 'result') this.events.push(message);
          },
        });
        return { execution };
      },
    };
    this.runtime = factories[provider]();
  }

  async run(report: unknown[]): Promise<void> {
    try {
      await this.runtime.initialize?.();
      await this.runtime.execution.run(PROMPT);
      await this.waitForResult();
      report.push({ provider: this.provider, signals: this.signals, events: this.events,
        diagnostics: this.diagnostics.entries, state: this.runtime.execution.session?.checkpoint() });
      const latest = this.signals.at(-1);
      console.log(JSON.stringify({ provider: this.provider, status: latest?.status ?? 'unknown',
        text: latest?.text, diagnostic: this.diagnostics.entries.at(-1)?.message }));
      if (this.signals.at(-1)?.status !== 'completed') {
        process.exitCode = 1;
        return;
      }
      await this.runtime.verifyCompleted?.();
    } catch (error) {
      report.push({ provider: this.provider, error: String(error), diagnostics: this.diagnostics.entries });
      console.log(`${this.provider}: ${error}`);
      process.exitCode = 1;
    } finally {
      this.runtime.execution.dispose();
      this.lease?.release();
    }
  }

  private createSession(sessionId: string, connectionId: string): Session {
    const binding: SessionBinding = { provider: this.provider, runtimeId: runtimeId(this.provider), sessionId,
      connectionId, windowInstanceId: randomUUID(), source: 'ownedExecution' };
    const lease = this.owner.claim(binding);
    this.lease = lease;
    return new Session(binding, () => lease.valid(), state => lease.save(state), signal => this.signals.push(signal), this.diagnostics);
  }

  private async waitForResult(): Promise<void> {
    // 최대 90초 동안 종료 결과를 기다리되 모든 턴이 unknown이면 즉시 검증으로 넘어간다.
    const deadline = Date.now() + 90_000;
    while (!this.signals.some(signal => signal.status !== 'waitingForInput') && Date.now() < deadline) {
      const turns = this.runtime.execution.session?.turns;
      if (turns?.size && [...turns.values()].every(turn => turn.status === 'unknown')) return;
      await delay(250);
    }
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

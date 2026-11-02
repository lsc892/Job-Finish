// 완료된 실제 Codex 검증 세션의 이력 복원과 결과 조회·재알림 방지를 검증한다.
// Read-only verification using completed probe sessions. Never starts another model turn.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecution } from '../../src/runtime/codex';
import { Session } from '../../src/core/session';
import { Diagnostics, Signal } from '../../src/core/model';
import { Lease, Ownership } from '../../src/core/ownership';
import { runtimeId } from '../../src/runtime/providers';

interface CapturedReport { scenario: string; passed: boolean; signals: Signal[] }
interface CapturedSource { cwd: string; report: CapturedReport }

function loadSources(): CapturedSource[] {
  const files = readdirSync('test-artifacts').filter(file => /^codex-input-\d+\.json$/.test(file));
  return files.flatMap(file => {
    const data = JSON.parse(readFileSync(join('test-artifacts', file), 'utf8')) as { tempWorkspace: string; reports: CapturedReport[] };
    return data.reports.filter(report => report.passed).map(report => ({ cwd: data.tempWorkspace, report }));
  });
}

function findSource(sources: CapturedSource[], scenario: string): CapturedSource {
  const source = sources.find(candidate => candidate.report.scenario === scenario);
  assert.ok(source, `A completed actual ${scenario} probe is required`);
  return source;
}

class CodexHistoryProbe {
  private readonly diagnostics = new Diagnostics();
  private readonly signals: Signal[] = [];
  private readonly runtime: CodexExecution;
  private lease?: Lease;

  constructor(private readonly source: CapturedSource, private readonly owner: Ownership) {
    this.runtime = new CodexExecution({
      cwd: source.cwd, executable: process.env.JOB_FINISH_LIVE_CODEX_EXECUTABLE, diagnostic: this.diagnostics,
      createSession: (sessionId, connectionId) => this.createSession(sessionId, connectionId),
    });
  }

  private get terminal(): Signal { return this.source.report.signals.at(-1)!; }

  async run(): Promise<unknown> {
    try {
      await this.runtime.open(this.terminal.sessionId);
      assert.equal(this.runtime.session!.completed.get(this.terminal.turnId), this.terminal.status);
      if (this.source.report.scenario !== 'cancel') {
        assert.equal(await this.runtime.readResult(this.terminal.turnId), this.terminal.text);
      }
      await this.runtime.reconnect();
      assert.equal(this.signals.length, 0);
      const result = { scenario: this.source.report.scenario, passed: true, status: this.terminal.status, pagedHistory: true, modelCalls: 0 };
      console.log(JSON.stringify(result));
      return result;
    } finally {
      this.runtime.dispose();
      this.lease?.release();
    }
  }

  private createSession(sessionId: string, connectionId: string): Session {
    const binding = { provider: 'codex', runtimeId: runtimeId('codex'), sessionId, connectionId,
      windowInstanceId: randomUUID(), source: 'ownedExecution' as const };
    const lease = this.owner.claim(binding);
    this.lease = lease;
    return new Session(binding, () => lease.valid(), state => lease.save(state), signal => this.signals.push(signal), this.diagnostics);
  }

}

function saveResults(results: unknown[]): void {
  writeFileSync('test-artifacts/codex-history.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-history-'));
  const owner = new Ownership(root);
  const sources = loadSources();
  const results: unknown[] = [];
  for (const scenario of ['question', 'approval', 'cancel']) {
    const source = findSource(sources, scenario);
    results.push(await new CodexHistoryProbe(source, owner).run());
  }
  saveResults(results);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });

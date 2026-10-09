// Read-only verification using completed probe sessions. Never starts another model turn.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecution } from '../src/runtime/codex';
import { Session } from '../src/core/session';
import { Diagnostics, Signal } from '../src/core/model';
import { Ownership } from '../src/core/ownership';
import { runtimeId } from '../src/runtime/executable';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-history-')); const owner = new Ownership(root);
  const sources = readdirSync('test-artifacts').filter(f => /^codex-input-\d+\.json$/.test(f)).flatMap(f => {
    const data = JSON.parse(readFileSync(join('test-artifacts', f), 'utf8'));
    return data.reports.filter((r: { passed: boolean }) => r.passed).map((report: unknown) => ({ cwd: data.tempWorkspace, report }));
  });
  const results: unknown[] = [];
  for (const scenario of ['question', 'approval', 'cancel']) {
    const source = sources.find(s => s.report.scenario === scenario);
    assert.ok(source, `A completed actual ${scenario} probe is required`);
    const terminal = source.report.signals.at(-1) as Signal;
    const diagnostics = new Diagnostics(); const signals: Signal[] = []; let release = () => {};
    const runtime = new CodexExecution({ cwd: source.cwd, executable: process.env.JOB_FINISH_LIVE_CODEX_EXECUTABLE, diagnostic: diagnostics,
      createSession: (sessionId, connectionId) => {
        const binding = { provider: 'codex' as const, runtimeId: runtimeId('codex'), sessionId, connectionId, windowInstanceId: randomUUID(), source: 'ownedExecution' as const };
        const lease = owner.claim(binding); release = () => lease.release();
        return new Session(binding, () => lease.valid(), s => lease.save(s), s => signals.push(s), diagnostics);
      } });
    try {
      await runtime.open(terminal.sessionId);
      assert.equal(runtime.session!.completed.get(terminal.turnId), terminal.status);
      if (scenario !== 'cancel') assert.equal(await runtime.readResult(terminal.turnId), terminal.text);
      await runtime.reconnect(); assert.equal(signals.length, 0);
      const result = { scenario, passed: true, status: terminal.status, pagedHistory: true, modelCalls: 0 };
      results.push(result); console.log(JSON.stringify(result));
    } finally { runtime.dispose(); release(); }
  }
  writeFileSync('test-artifacts/codex-history.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

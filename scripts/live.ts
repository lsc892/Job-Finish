// Explicitly run by `npm run test:live`; never called by the offline test suite.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexExecution } from '../src/runtime/codex';
import { ClaudeExecution } from '../src/runtime/claude';
import { Diagnostics, SessionBinding, Signal } from '../src/core/model';
import { Session } from '../src/core/session';
import { Ownership } from '../src/core/ownership';
import { runtimeId } from '../src/runtime/executable';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-live-')); const owner = new Ownership(root);
  const report: unknown[] = []; const providers = process.argv.slice(2).filter(p => p === 'codex' || p === 'claude');
  for (const provider of providers.length ? providers : ['codex', 'claude']) {
    const signals: Signal[] = []; const events: unknown[] = []; const diagnostics = new Diagnostics();
    let release = () => {};
    const createSession = (sessionId: string, connectionId: string) => {
      const binding: SessionBinding = { provider: provider as 'codex' | 'claude', runtimeId: runtimeId(provider as 'codex' | 'claude'), sessionId, connectionId, windowInstanceId: randomUUID(), source: 'ownedExecution' };
      const lease = owner.claim(binding); release = () => lease.release();
      return new Session(binding, () => lease.valid(), state => lease.save(state), signal => signals.push(signal), diagnostics);
    };
    const execution = provider === 'codex' ? new CodexExecution({ cwd: root, diagnostic: diagnostics, createSession, executable: process.env.JOB_FINISH_LIVE_CODEX_EXECUTABLE, model: process.env.JOB_FINISH_LIVE_CODEX_MODEL,
      onEvent: message => { if (['turn/started', 'turn/completed', 'item/completed'].includes(message.method ?? '')) events.push(message); } }) :
      new ClaudeExecution({ cwd: root, maxTurns: 2, resume: false, session: createSession(randomUUID(), randomUUID()),
        onEvent: message => { if (message.type === 'result') events.push(message); } });
    try {
      if (execution instanceof CodexExecution) await execution.open();
      await execution.run('This is a connectivity test in an empty temporary directory. Do not use tools, read or write files, or start background tasks. Reply with exactly JOB_FINISH_LIVE_OK.');
      const deadline = Date.now() + 90_000;
      while (!signals.some(s => s.status !== 'waitingForInput') && Date.now() < deadline) {
        if (execution.session?.turns.size && [...execution.session.turns.values()].every(t => t.status === 'unknown')) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      report.push({ provider, signals, events, diagnostics: diagnostics.entries, state: execution.session?.checkpoint() });
      console.log(JSON.stringify({ provider, status: signals.at(-1)?.status ?? 'unknown', text: signals.at(-1)?.text, diagnostic: diagnostics.entries.at(-1)?.message }));
      if (signals.at(-1)?.status !== 'completed') process.exitCode = 1;
      if (execution instanceof CodexExecution && signals.at(-1)?.status === 'completed') {
        await execution.reconnect();
        if (signals.length !== 1) throw new Error('Historical result replayed after reconnection');
        console.log('Codex reconnect: no historical re-notification');
      }
    } catch (error) { report.push({ provider, error: String(error), diagnostics: diagnostics.entries }); console.log(`${provider}: ${error}`); process.exitCode = 1; }
    finally { execution.dispose(); release(); }
  }
  mkdirSync('test-artifacts', { recursive: true });
  writeFileSync(`test-artifacts/live-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), tempWorkspace: root, report }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

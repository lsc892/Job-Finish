// Opt-in App Server probes using the product transport, adapter, ownership and response path.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecution, codexApprovalResponse } from '../src/runtime/codex';
import { Diagnostics, Signal } from '../src/core/model';
import { Session } from '../src/core/session';
import { Ownership } from '../src/core/ownership';
import { runtimeId } from '../src/runtime/executable';
import type { RpcMessage } from '../src/runtime/transport';
import type { ToolRequestUserInputParams } from '../src/protocol/v2/ToolRequestUserInputParams';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-codex-input-')); const owner = new Ownership(root);
  const reports: unknown[] = []; const selected = process.argv.slice(2);
  for (const scenario of selected.length ? selected : ['question', 'cancel', 'approval']) {
    const diagnostics = new Diagnostics(); const signals: Signal[] = []; const events: RpcMessage[] = [];
    const replies: unknown[] = []; let release = () => {}; let handled = false;
    const question = scenario === 'question' || scenario === 'cancel';
    const execution = new CodexExecution({ cwd: root, executable: process.env.JOB_FINISH_LIVE_CODEX_EXECUTABLE,
      model: process.env.JOB_FINISH_LIVE_CODEX_MODEL, mode: question ? 'plan' : 'default', sandbox: 'read-only', permissionRequests: scenario === 'permissions', diagnostic: diagnostics,
      onEvent: message => { if (message.method && (['turn/started', 'turn/completed', 'serverRequest/resolved'].includes(message.method) || message.method.endsWith('requestApproval') || message.method.endsWith('requestUserInput') || message.method === 'item/completed')) events.push(message); },
      createSession: (sessionId, connectionId) => {
        const binding = { provider: 'codex' as const, runtimeId: runtimeId('codex'), sessionId, connectionId, windowInstanceId: randomUUID(), source: 'ownedExecution' as const };
        const lease = owner.claim(binding); release = () => lease.release();
        return new Session(binding, () => lease.valid(), state => lease.save(state), s => signals.push(s), diagnostics);
      } });
    try {
      await execution.open();
      await execution.run(question
        ? 'This is a bounded user-input integration test. Do not inspect files, use shell commands, browse, or start agents. Use request_user_input exactly once to ask which color to use, offering Blue and Green. You must wait for that tool response. After the response, reply JOB_FINISH_CODEX_INPUT_OK and the chosen color. No further questions or implementation.'
        : scenario === 'permissions' ? `This is a bounded permissions integration test. Do not read any files, run commands, browse, or start agents. Use request_permissions exactly once to ask write permission for this single temporary directory: ${root}. Ask for no network access and no other paths. If denied, do not retry or write anything; reply JOB_FINISH_PERMISSION_DENIED. If allowed, reply JOB_FINISH_PERMISSION_ALLOWED without changing files.`
        : 'This is a bounded command approval integration test. Use the shell command tool exactly once to run Write-Output JOB_FINISH_APPROVAL_OK, explicitly requesting sandbox_permissions require_escalated with justification "May I print the integration-test marker?". This deliberately tests the approval handshake for a harmless stdout-only command. Do not read or change files, browse, use other commands, or start agents. If declined, do not retry; reply JOB_FINISH_APPROVAL_DENIED.');
      const deadline = Date.now() + 90_000;
      while (!signals.some(s => s.status !== 'waitingForInput')) {
        if (Date.now() > deadline) throw new Error('Codex input probe timed out');
        const pending = [...execution.session!.requests.values()][0];
        if (pending && !handled) {
          handled = true;
          if (scenario === 'cancel') { await execution.cancel(); replies.push({ action: 'interrupt' }); }
          else if (question) {
            assert.equal(pending.kind, 'question');
            const p = (pending.payload as RpcMessage).params as ToolRequestUserInputParams;
            const response = { answers: Object.fromEntries(p.questions.map(q => [q.id, { answers: ['Blue'] }])) };
            execution.respond(pending.id, response); replies.push({ requestId: pending.id, response });
          } else {
            assert.equal((pending.payload as RpcMessage).method, scenario === 'permissions' ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval');
            const response = codexApprovalResponse(pending.payload as RpcMessage, false);
            execution.respond(pending.id, response); replies.push({ requestId: pending.id, response });
          }
        }
        if ([...execution.session!.turns.values()].some(t => t.status === 'unknown')) throw new Error('Codex execution became unknown');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(handled, true, 'Must observe an actual input request');
      assert.equal(signals.at(-1)!.status, scenario === 'cancel' ? 'cancelled' : 'completed');
      assert.equal(execution.session!.requests.size, 0);
      if (scenario !== 'cancel') assert.equal(await execution.readResult(signals.at(-1)!.turnId), signals.at(-1)!.text, 'Actual paged final result retrieval');
      const count = signals.length; await execution.reconnect(); assert.equal(signals.length, count, 'No replay after actual reconnect');
      reports.push({ scenario, passed: true, signals, events, replies });
      console.log(JSON.stringify({ scenario, passed: true, status: signals.at(-1)!.status }));
    } catch (error) {
      const usageLimited = events.some(e => e.method === 'turn/completed' && (e.params as { turn?: { error?: { codexErrorInfo?: string } } })?.turn?.error?.codexErrorInfo === 'usageLimitExceeded');
      reports.push({ scenario, passed: false, error: String(error), signals, events, replies, diagnostics: diagnostics.entries });
      console.error(`${scenario}: ${usageLimited ? 'Actual account usage limit reached; stopping further model probes' : error}`); process.exitCode = 1;
      if (usageLimited) break;
    }
    finally { execution.dispose(); release(); }
  }
  mkdirSync('test-artifacts', { recursive: true });
  const path = `test-artifacts/codex-input-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), tempWorkspace: root, reports }, null, 2)); console.log(path);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

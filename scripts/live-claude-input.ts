// Opt-in actual SDK checks. Tool access is restricted to one question or one file in an owned temporary directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeExecution } from '../src/runtime/claude';
import { Diagnostics, Signal } from '../src/core/model';
import { Session } from '../src/core/session';
import { Ownership } from '../src/core/ownership';
import { runtimeId } from '../src/runtime/executable';

async function main(): Promise<void> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(join(tmpdir(), 'job-finish-claude-input-'));
  const owner = new Ownership(root); const reports: unknown[] = [];
  const selected = process.argv.slice(2);
  for (const scenario of selected.length ? selected : ['question', 'approval', 'cancel', 'turn-limit']) {
    const diagnostics = new Diagnostics(); const signals: Signal[] = []; const events: unknown[] = []; const requests: unknown[] = [];
    const binding = { provider: 'claude' as const, runtimeId: runtimeId('claude'), sessionId: randomUUID(), connectionId: randomUUID(), windowInstanceId: randomUUID(), source: 'ownedExecution' as const };
    const lease = owner.claim(binding);
    const session = new Session(binding, () => lease.valid(), state => lease.save(state), s => signals.push(s), diagnostics);
    const isQuestion = scenario === 'question' || scenario === 'cancel';
    const target = join(root, `${scenario}.txt`);
    const execution = new ClaudeExecution({ cwd: root, maxTurns: scenario === 'turn-limit' ? 1 : 4, session, resume: false,
      onEvent: message => { if (message.type === 'result' || message.type === 'rate_limit_event') events.push(message); },
      createQuery: args => query({ ...args, options: { ...args.options, settingSources: [], tools: [isQuestion ? 'AskUserQuestion' : 'Write'],
        canUseTool: async (tool, input, options) => {
          requests.push({ tool, input, requestId: options.requestId, toolUseID: options.toolUseID });
          return args.options!.canUseTool!(tool, input, options);
        } } }) });
    let handled = false;
    try {
      await execution.run(isQuestion
        ? 'This is a bounded integration test. You must call AskUserQuestion exactly once to ask which color to use, with Blue and Green choices. Do not answer the question yourself. After the user answers, reply with JOB_FINISH_INPUT_OK and the chosen color. Do not use other tools or background tasks.'
        : `This is a bounded integration test. Use Write exactly once to write the exact text JOB_FINISH_APPROVAL_OK to this temporary file: ${target}. Do not use other tools, read other files, or start background tasks. Then reply JOB_FINISH_INPUT_OK.`);
      const end = Date.now() + 90_000;
      while (!signals.some(s => s.status !== 'waitingForInput')) {
        if (Date.now() > end) throw new Error('Actual SDK input test timed out');
        const pending = [...session.requests.values()][0];
        if (pending && !handled) {
          handled = true;
          if (scenario === 'cancel') await execution.cancel();
          else {
            const { toolName, input } = pending.payload as { toolName: string; input: Record<string, unknown> };
            if (isQuestion) {
              assert.equal(toolName, 'AskUserQuestion');
              const questions = input.questions as { question: string }[];
              execution.respond(pending.id, { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map(q => [q.question, 'Blue'])) } });
            } else {
              assert.equal(toolName, 'Write'); assert.equal(input.file_path, target); assert.equal(input.content, 'JOB_FINISH_APPROVAL_OK');
              execution.respond(pending.id, { behavior: 'allow', updatedInput: input });
            }
          }
        }
        if ([...session.turns.values()].some(t => t.status === 'unknown')) throw new Error('SDK execution became unknown');
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(handled, true, 'Actual SDK control request must be observed');
      assert.equal(signals.at(-1)!.status, scenario === 'cancel' ? 'cancelled' : scenario === 'turn-limit' ? 'error' : 'completed');
      assert.equal(session.requests.size, 0);
      if (!isQuestion) assert.equal(readFileSync(target, 'utf8'), 'JOB_FINISH_APPROVAL_OK');
      if (scenario === 'turn-limit') assert.ok(events.some(e => (e as { subtype?: string }).subtype === 'error_max_turns'));
      reports.push({ scenario, passed: true, signals, requests, events });
      console.log(JSON.stringify({ scenario, passed: true, status: signals.at(-1)!.status, inputRequests: requests.length }));
    } catch (error) {
      reports.push({ scenario, passed: false, error: String(error), signals, requests, events, diagnostics: diagnostics.entries });
      console.error(`${scenario}: ${error}`); process.exitCode = 1;
    } finally { execution.dispose(); lease.release(); }
  }
  mkdirSync('test-artifacts', { recursive: true });
  const file = `test-artifacts/claude-input-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tempWorkspace: root, reports }, null, 2)); console.log(file);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

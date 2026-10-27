import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Diagnostics, InputRequest, Signal } from '../src/core/model';
import { Session } from '../src/core/session';
import { Notifications } from '../src/core/notifications';
import { AgentProvider, AgentProviderRegistry } from '../src/runtime/agent-provider';
import type { AgentEvents, AgentExecution, AgentInteraction, EventContext, ExecutionContext } from '../src/runtime/agent-provider';
import { agentProviders } from '../src/runtime/providers';
import { AgentEventRouter } from '../src/runtime/event-router';
import { AgentStreamObserver } from '../src/runtime/observe';
import { binding } from './helpers';

/** An independent third protocol exercises the public provider extension points. */
class SampleProvider extends AgentProvider {
  readonly id: string = 'sample';
  readonly extensionId = 'example.sample';
  readonly runCommand: string = 'runSample';
  disposed = 0;
  matchesProcess(args: readonly string[]): boolean { return args.includes('sample-agent'); }
  runtimeDirectory(): string { return tmpdir(); }
  createEvents(context: EventContext): AgentEvents {
    let turnId = 'default';
    return {
      outgoing: message => { if (typeof message.request === 'string') turnId = message.request; },
      incoming: message => {
        if (typeof message.done !== 'string') return;
        const session = context.session('sample-session');
        session?.start(turnId, context.connectionId);
        session?.body(turnId, message.done, context.connectionId);
        session?.finish(turnId, 'completed', context.connectionId);
      },
      dispose: () => { this.disposed++; },
    };
  }
  createExecution(context: ExecutionContext): AgentExecution {
    const session = context.createSession(context.sessionId ?? 'sample-session', 'sample-connection');
    return { session, run: async prompt => {
      session.start('owned-turn', session.binding.connectionId);
      session.body('owned-turn', prompt, session.binding.connectionId);
      session.finish('owned-turn', 'completed', session.binding.connectionId);
    }, cancel: async () => {}, reconnect: async () => {}, respond: () => {}, readResult: async () => undefined, dispose: () => {} };
  }
  protected approvalResponse(_request: InputRequest, allow: boolean): unknown { return { allow }; }
  protected async answerQuestions(request: InputRequest, interaction: AgentInteraction): Promise<unknown> {
    return interaction.question(request.title, [], { multiSelect: false, secret: false });
  }
}

function interaction(allow: boolean | undefined = undefined, answers: (string[] | undefined)[] = [['Blue']]) {
  const shown: unknown[] = [];
  const questions: unknown[][] = [];
  const ui: AgentInteraction = {
    showRequest: async payload => { shown.push(payload); },
    approve: async title => { assert.equal(shown.length, 1); shown.push(title); return allow; },
    question: async (...args) => { questions.push(args); return answers.shift(); },
  };
  return { ui, shown, questions };
}
const request = (payload: unknown, kind: InputRequest['kind'] = 'approval'): InputRequest =>
  ({ id: 'input', turnId: 'turn', connectionId: 'connection', title: 'Choose', kind, payload });
function executionContext(provider: string, signals: Signal[], sessionId?: string): ExecutionContext {
  return { cwd: process.cwd(), sessionId, diagnostics: new Diagnostics(),
    config: (key, fallback) => key === 'codexExecutable' ? resolve('tests/fixtures/app-server.cjs') as typeof fallback : fallback,
    createSession: (id, connectionId) => new Session(binding({ provider, sessionId: id, connectionId }), () => true, () => {}, s => signals.push(s), new Diagnostics()) };
}
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Provider fixture timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('A third subclass is selected by the registry; unknown IDs and duplicate registrations fail explicitly', () => {
  const sample = new SampleProvider();
  const registry = new AgentProviderRegistry([...agentProviders.all(), sample]);
  assert.equal(registry.match(['node', 'sample-agent']), sample);
  assert.equal(registry.match(['node', 'app-server'])?.id, 'codex');
  assert.equal(registry.match(['claude', '--output-format=stream-json'])?.id, 'claude');
  assert.equal(registry.match(['claude', '--output-format', 'stream-json'])?.id, 'claude');
  assert.equal(registry.match(['node', 'unrelated']), undefined);
  assert.equal(registry.get('sample'), sample);
  assert.throws(() => registry.get('missing'), /Unsupported agent provider/);
  assert.throws(() => new AgentEventRouter('missing', 'w', 'r', () => {}, new Diagnostics()), /Unsupported agent provider/);
  assert.throws(() => new AgentProviderRegistry([sample, new SampleProvider()]), /Duplicate agent provider/);
  const other = new class extends SampleProvider { readonly id = 'other'; }();
  assert.throws(() => new AgentProviderRegistry([sample, other]), /Duplicate agent command/);
});

test('Third-provider routers isolate connection state, deduplicate results and preserve ownership and disposal', () => {
  const sample = new SampleProvider(); const registry = new AgentProviderRegistry([sample]); const signals: Signal[] = [];
  const first = new AgentEventRouter('sample', 'A', 'r', s => signals.push(s), new Diagnostics(), () => false, registry);
  const second = new AgentEventRouter('sample', 'B', 'r', s => signals.push(s), new Diagnostics(), () => false, registry);
  const owned = new AgentEventRouter('sample', 'A', 'r', s => signals.push(s), new Diagnostics(), () => true, registry);
  first.outgoing({ request: 'first' }); second.outgoing({ request: 'second' });
  for (const router of [first, second, owned]) { router.incoming(null); router.incoming({ done: 'DONE' }); router.incoming({ done: 'DONE' }); }
  assert.deepEqual(signals.map(s => [s.provider, s.windowInstanceId, s.turnId]), [['sample', 'A', 'first'], ['sample', 'B', 'second']]);
  assert.notEqual(signals[0]!.connectionId, signals[1]!.connectionId);
  first.dispose(); first.outgoing({ request: 'after-dispose' }); first.incoming({ done: 'ignored' });
  assert.equal(signals.length, 2); assert.equal(first.snapshot().sessions, 0);
  second.dispose(); owned.dispose(); assert.equal(sample.disposed, 3);
});

test('A registered third provider observes a real child and reaches the shared notification service with unchanged bytes', async t => {
  const sample = new SampleProvider(); const registry = new AgentProviderRegistry([sample]); const signals: Signal[] = []; const toasts: string[] = [];
  const diagnostics = new Diagnostics();
  const notifications = new Notifications({ focused: () => false, owns: () => true, stopFlash: () => {}, flash: () => {}, activate: () => {},
    toast: async (_signal, message) => { toasts.push(message); } });
  const observer = new AgentStreamObserver('window', () => [{ provider: 'sample', path: resolve('tests/fixtures') }], s => {
    signals.push(s); void notifications.deliver(s);
  }, diagnostics, () => false, registry);
  t.after(() => observer.dispose()); observer.start();
  const child = spawn(process.execPath, [resolve('tests/fixtures/observed-agent.cjs'), 'sample-agent'], { stdio: 'pipe', windowsHide: true });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); });
  });
  const bytes: Buffer[] = []; child.stdout.on('data', chunk => bytes.push(chunk));
  child.stdin.write(JSON.stringify({ request: 'third-turn', events: [{ done: '세 번째 에이전트😀' }] }) + '\n');
  await until(() => toasts.length === 1);
  assert.equal(signals[0]!.provider, 'sample'); assert.equal(signals[0]!.turnId, 'third-turn');
  assert.equal(observer.owns(signals[0]!), true); assert.equal(observer.snapshot().connections.length, 1);
  assert.deepEqual(toasts, ['세 번째 에이전트😀']); assert.equal(diagnostics.entries.length, 0);
  assert.equal(Buffer.concat(bytes).toString('utf8'), JSON.stringify({ done: toasts[0] }) + '\n');
  observer.stop(); assert.equal(sample.disposed, 1);
});

test('Common approval UI displays the request first and preserves each provider response format and cancellation', async () => {
  const cases: [string, unknown, unknown, unknown][] = [
    ['codex', { method: 'item/commandExecution/requestApproval' }, { decision: 'accept' }, { decision: 'decline' }],
    ['codex', { method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } },
      { scope: 'turn', permissions: { network: { enabled: true } } }, { scope: 'turn', permissions: {} }],
    ['claude', { input: { command: 'echo sample' } }, { behavior: 'allow', updatedInput: { command: 'echo sample' } }, { behavior: 'deny', message: 'Denied by user' }],
  ];
  for (const [id, payload, accepted, denied] of cases) for (const allow of [true, false, undefined]) {
    const ui = interaction(allow); const result = await agentProviders.get(id).answer(request(payload), ui.ui);
    assert.deepEqual(ui.shown, [payload, 'Choose']);
    assert.deepEqual(result, allow === undefined ? undefined : allow ? accepted : denied);
  }
});

test('Provider question conversion preserves Codex IDs and secrets, Claude multi-select and partial cancellation', async () => {
  const codex = request({ params: { questions: [{ id: 'color', question: 'Color?', isSecret: true, options: [{ label: 'Blue', description: 'sky' }] }] } }, 'question');
  const codexUi = interaction();
  assert.deepEqual(await agentProviders.get('codex').answer(codex, codexUi.ui), { answers: { color: { answers: ['Blue'] } } });
  assert.deepEqual(codexUi.questions[0], ['Color?', [{ label: 'Blue', description: 'sky' }], { multiSelect: false, secret: true }]);
  const input = { questions: [{ question: 'Colors?', multiSelect: true, options: [{ label: 'Blue' }, { label: 'Red' }] }], extra: 'preserved' };
  const claudeUi = interaction(true, [['Blue', 'Red']]);
  assert.deepEqual(await agentProviders.get('claude').answer(request({ input }, 'question'), claudeUi.ui),
    { behavior: 'allow', updatedInput: { ...input, answers: { 'Colors?': 'Blue, Red' } } });
  assert.deepEqual(claudeUi.questions[0]![2], { multiSelect: true, secret: false });
  for (const id of ['codex', 'claude']) {
    const payload = id === 'codex' ? { params: { questions: [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }] } }
      : { input: { questions: [{ question: 'First?' }, { question: 'Second?' }] } };
    assert.equal(await agentProviders.get(id).answer(request(payload, 'question'), interaction(true, [['first'], undefined]).ui), undefined);
  }
});

test('Registered execution factories run a third agent and the real Codex stdio fixture; Claude retains its supplied session', async t => {
  const signals: Signal[] = [];
  const registry = new AgentProviderRegistry([...agentProviders.all(), new SampleProvider()]);
  for (const id of ['sample', 'codex']) {
    const execution = registry.get(id).createExecution(executionContext(id, signals)); t.after(() => execution.dispose());
    if (execution.open) await execution.open();
    await execution.run(`${id}_FACTORY_OK`);
    await until(() => signals.some(s => s.provider === id));
    assert.equal(signals.find(s => s.provider === id)!.text, `${id}_FACTORY_OK`);
  }
  const claude = registry.get('claude').createExecution(executionContext('claude', signals, 'saved-session')); t.after(() => claude.dispose());
  assert.equal(claude.session!.binding.provider, 'claude'); assert.equal(claude.session!.binding.sessionId, 'saved-session');
  const resumed = registry.get('codex').createExecution(executionContext('codex', signals, 'history-large')); t.after(() => resumed.dispose());
  await resumed.open!('history-large'); assert.equal(resumed.session!.binding.sessionId, 'history-large');
  assert.equal(signals.length, 2);
});

test('Runtime identity is stable across canonical directory aliases and separates provider IDs and homes', () => {
  let directory = tmpdir();
  const sample = new class extends SampleProvider { runtimeDirectory(): string { return directory; } }();
  const original = sample.runtimeId();
  directory += '/.';
  assert.equal(sample.runtimeId(), original);
  if (process.platform === 'win32') { directory = directory.toUpperCase(); assert.equal(sample.runtimeId(), original); }
  directory = resolve(tmpdir(), 'other-agent-home'); assert.notEqual(sample.runtimeId(), original);
  const other = new class extends SampleProvider { readonly id = 'other'; }();
  assert.notEqual(original, other.runtimeId());
});

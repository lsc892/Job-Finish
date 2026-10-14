import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Diagnostics, Signal } from '../src/core/model';
import { Notifications } from '../src/core/notifications';
import { AgentEventRouter } from '../src/runtime/event-router';
import { AgentStreamObserver } from '../src/runtime/observe';

function setup() {
  const signals: Signal[] = []; const diagnostics = new Diagnostics();
  const router = new AgentEventRouter('codex', 'window', 'runtime', signal => signals.push(signal), diagnostics);
  return { router, signals, diagnostics };
}
const start = (threadId: string, items: unknown[] = []) => ({ method: 'turn/started', params: {
  threadId, turn: { id: `turn-${threadId}`, status: 'inProgress', items }
} });
const final = (threadId: string, text = `Finished ${threadId}`) => ({ type: 'agentMessage', id: `message-${threadId}`,
  phase: 'final_answer', text });
const itemEvent = (threadId: string, item: unknown, method = 'item/completed') => ({ method,
  params: { threadId, turnId: `turn-${threadId}`, item } });
const complete = (threadId: string, items: unknown[] = [final(threadId)]) => ({ method: 'turn/completed', params: {
  threadId, turn: { id: `turn-${threadId}`, status: 'completed', items }
} });
const activity = (agentThreadId: string, kind = 'started') => ({ type: 'subAgentActivity', id: `activity-${agentThreadId}`,
  kind, agentThreadId, agentPath: `/root/${agentThreadId}` });
const collaboration = (senderThreadId: string, receiverThreadIds: string[], tool = 'spawnAgent') => ({ type: 'collabAgentToolCall',
  id: `collab-${tool}-${senderThreadId}`, tool, status: 'completed', senderThreadId, receiverThreadIds,
  prompt: null, model: null, reasoningEffort: null,
  agentsStates: Object.fromEntries(receiverThreadIds.map(id => [id, { status: 'completed', message: `Finished ${id}` }])) });
const question = (threadId: string, id: number) => ({ id, method: 'item/tool/requestUserInput', params: {
  threadId, turnId: `turn-${threadId}`, itemId: `question-${id}`,
  questions: [{ id: 'answer', header: 'Decision', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }]
} });
const status = (threadId: string, type: 'idle' | 'active') => ({ method: 'thread/status/changed',
  params: { threadId, status: type === 'active' ? { type, activeFlags: [] } : { type } } });

test('Parent live activity identifies metadata-free Codex children before their completion can notify', () => {
  for (const method of ['item/started', 'item/completed']) {
    for (const evidence of [activity('child'), collaboration('root', ['child'])]) {
      const f = setup(); f.router.incoming(start('root'));
      f.router.incoming(itemEvent('root', evidence, method));
      f.router.incoming(start('child')); f.router.incoming(itemEvent('child', final('child')));
      f.router.incoming(complete('child'));
      assert.equal(f.signals.length, 0, `${method}: ${evidence.type}`);
      assert.equal(f.router.snapshot().activeTurns, 1);
      f.router.incoming(itemEvent('root', final('root', 'All requested work is finished.')));
      assert.equal(f.signals.length, 0);
      f.router.incoming(complete('root', [])); f.router.incoming(complete('root', []));
      assert.deepEqual(f.signals.map(signal => [signal.sessionId, signal.status, signal.text]),
        [['root', 'completed', 'All requested work is finished.']]);
      assert.equal(f.router.snapshot().activeTurns, 0); assert.equal(f.diagnostics.entries.length, 0);
    }
  }
});

test('An excluded child can identify its own nested agents without admitting their turns', () => {
  const f = setup(); f.router.incoming(start('root'));
  f.router.incoming(itemEvent('root', collaboration('root', ['child'])));
  f.router.incoming(start('child'));
  f.router.incoming(itemEvent('child', collaboration('child', ['nested']), 'item/started'));
  f.router.incoming(itemEvent('nested', activity('leaf')));
  for (const id of ['leaf', 'nested', 'child']) {
    f.router.incoming(start(id)); f.router.incoming(itemEvent(id, final(id))); f.router.incoming(complete(id));
  }
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(complete('root')); assert.deepEqual(f.signals.map(signal => signal.sessionId), ['root']);
});

test('Installed Codex spawn ordering needs no child thread/started metadata and removes its early status session', () => {
  const f = setup(); f.router.incoming(start('root'));
  f.router.incoming(itemEvent('root', collaboration('root', []), 'item/started'));
  f.router.incoming(status('child', 'idle'));
  assert.equal(f.router.snapshot().sessions, 2); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(itemEvent('root', collaboration('root', ['child'])));
  assert.equal(f.router.snapshot().sessions, 1);
  f.router.incoming(status('child', 'active')); f.router.incoming(start('child'));
  f.router.incoming(itemEvent('child', final('child')));
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  // The real runtime can finish the main turn before child stdout has drained.
  f.router.incoming(status('root', 'idle')); f.router.incoming(complete('root'));
  f.router.incoming(status('child', 'idle')); f.router.incoming(complete('child'));
  assert.deepEqual(f.signals.map(signal => [signal.sessionId, signal.status]), [['root', 'completed']]);
  assert.equal(f.router.snapshot().activeTurns, 0);
});

test('Live turn snapshots identify children while collaboration statuses never finish the parent', () => {
  const f = setup();
  f.router.incoming(start('root', [activity('child'), collaboration('root', ['second'])]));
  for (const id of ['child', 'second']) { f.router.incoming(start(id)); f.router.incoming(complete(id)); }
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(itemEvent('root', collaboration('root', ['child', 'second'], 'wait')));
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(complete('root', [activity('third', 'completed'), collaboration('root', ['fourth']), final('root')]));
  assert.deepEqual(f.signals.map(signal => [signal.sessionId, signal.text]), [['root', 'Finished root']]);
  for (const id of ['third', 'fourth']) f.router.incoming(complete(id));
  assert.equal(f.signals.length, 1); assert.equal(f.router.snapshot().activeTurns, 0);
});

test('History teaches child relationships without admitting or notifying completed history turns', () => {
  const f = setup();
  f.router.incoming({ id: 10, result: { thread: { id: 'root', turns: [{ id: 'historical', status: 'completed',
    items: [activity('child'), collaboration('root', ['second']), final('root', 'Old answer')] }] } } });
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 0);
  f.router.incoming(start('root'));
  for (const id of ['child', 'second']) { f.router.incoming(start(id)); f.router.incoming(complete(id)); }
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(complete('root')); assert.deepEqual(f.signals.map(signal => signal.text), ['Finished root']);
});

test('Late child classification discards its live state and requests while keeping the parent request', () => {
  const f = setup(); f.router.incoming(start('root')); f.router.incoming(start('child'));
  f.router.incoming(question('root', 40)); f.router.incoming(question('child', 41));
  assert.equal(f.router.snapshot().activeTurns, 2); assert.equal(f.router.snapshot().pendingRequests, 2);
  const before = f.signals.length;
  f.router.incoming(itemEvent('root', activity('child')));
  assert.equal(f.router.snapshot().activeTurns, 1); assert.equal(f.router.snapshot().pendingRequests, 1);
  f.router.outgoing({ id: 41, result: { answers: {} } });
  assert.equal(f.router.snapshot().pendingRequests, 1);
  f.router.incoming(complete('child')); assert.equal(f.signals.length, before);
  f.router.outgoing({ id: 40, result: { answers: {} } });
  assert.equal(f.router.snapshot().pendingRequests, 0);
  f.router.incoming(complete('root')); assert.equal(f.signals.length, before + 1);
  assert.equal(f.signals.at(-1)!.sessionId, 'root'); assert.equal(f.signals.at(-1)!.status, 'completed');
});

test('Subagent metadata still excludes a child and cleans up a previously observed turn', () => {
  for (const metadata of [{ parentThreadId: 'root' }, { source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } }, { ephemeral: true }]) {
    const f = setup(); f.router.incoming(start('root')); f.router.incoming(start('child'));
    f.router.incoming({ method: 'thread/started', params: { thread: { id: 'child', ...metadata } } });
    assert.equal(f.router.snapshot().activeTurns, 1);
    f.router.incoming(complete('child')); assert.equal(f.signals.length, 0);
    f.router.incoming(complete('root')); assert.equal(f.signals[0]!.sessionId, 'root');
  }
});

test('Thread listings identify child metadata without notifying history or excluding main threads', () => {
  const f = setup();
  f.router.incoming({ id: 50, result: { data: [{ id: 'root', source: 'vscode', turns: [] },
    { id: 'child', parentThreadId: 'root', source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } },
      turns: [{ id: 'historical-child', status: 'completed', items: [final('child')] }] }], nextCursor: null } });
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 0);
  f.router.incoming(start('root')); f.router.incoming(start('child')); f.router.incoming(complete('child'));
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 1);
  f.router.incoming(complete('root')); assert.equal(f.signals[0]!.sessionId, 'root');
});

test('Self references, collaboration sender IDs, and agent listings preserve independent main threads', () => {
  const f = setup(); f.router.incoming(start('root')); f.router.incoming(start('other-root'));
  f.router.incoming(itemEvent('root', activity('root')));
  f.router.incoming(itemEvent('root', collaboration('root', ['root', 'other-root'], 'listAgents')));
  f.router.incoming(itemEvent('root', collaboration('other-root', ['root', 'other-root', 'child'])));
  for (const tool of ['wait', 'sendMessage', 'sendInput', 'resumeAgent', 'followupTask', 'interruptAgent', 'closeAgent', 'listAgents']) {
    f.router.incoming(itemEvent('child', collaboration('child', ['root', 'other-root'], tool)));
  }
  f.router.incoming(start('child')); f.router.incoming(complete('child'));
  assert.equal(f.signals.length, 0); assert.equal(f.router.snapshot().activeTurns, 2);
  f.router.incoming(complete('other-root')); f.router.incoming(complete('root'));
  assert.deepEqual(f.signals.map(signal => signal.sessionId), ['other-root', 'root']);
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Codex subagent stdio fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Real observed Codex stdio flashes and toasts only when the main turn finishes, preserving provider bytes', async t => {
  const child = spawn(process.execPath, [resolve('tests/fixtures/observed-agent.cjs'), 'app-server'],
    { stdio: 'pipe', windowsHide: true });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(done => { child.once('close', () => done()); child.kill(); });
  });
  const bytes: Buffer[] = []; child.stdout.on('data', chunk => bytes.push(chunk));
  const originalWrite = child.stdin.write; const forwarded: unknown[][] = [];
  child.stdin.write = function(this: typeof child.stdin, ...args: unknown[]): boolean {
    forwarded.push(args); return Reflect.apply(originalWrite, this, args) as boolean;
  } as typeof child.stdin.write;
  const diagnostics = new Diagnostics(); const flashes: Signal[] = []; const toasts: { signal: Signal; text: string }[] = [];
  const deliveries: Promise<void>[] = [];
  const notifications = new Notifications({ focused: () => false, owns: signal => observer.owns(signal),
    stopFlash: () => {}, flash: signal => flashes.push(signal), activate: () => {},
    toast: async (signal, text, _click, allowed) => {
      if (allowed()) toasts.push({ signal, text });
    } });
  const observer = new AgentStreamObserver('window', () => [{ provider: 'codex', path: resolve('tests/fixtures') }],
    signal => deliveries.push(notifications.deliver(signal)), diagnostics);
  t.after(() => observer.dispose()); observer.start();
  const firstEvents = [start('root'), itemEvent('root', collaboration('root', []), 'item/started'), status('child', 'idle'),
    itemEvent('root', collaboration('root', ['child'])), status('child', 'active'), start('child'),
    itemEvent('child', final('child', '서브 작업 완료')), complete('child')];
  const first = Buffer.from(JSON.stringify({ events: firstEvents }) + '\n'); child.stdin.write(first);
  const firstBytes = firstEvents.map(event => JSON.stringify(event) + '\n').join('');
  await until(() => Buffer.concat(bytes).byteLength >= Buffer.byteLength(firstBytes)); await Promise.all(deliveries);
  assert.equal(forwarded[0]![0], first); assert.equal(Buffer.concat(bytes).toString('utf8'), firstBytes);
  assert.equal(toasts.length, 0); assert.equal(flashes.length, 0);
  assert.equal(observer.snapshot().connections[0]!.activeTurns, 1);

  const finalEvents = [itemEvent('root', final('root', '메인 작업 완료 😀')), complete('root', [])];
  child.stdin.write(JSON.stringify({ events: finalEvents }) + '\n');
  await until(() => toasts.length === 1); await Promise.all(deliveries);
  assert.equal(toasts.length, 1); assert.equal(flashes.length, 1); assert.equal(toasts[0]!.signal.sessionId, 'root');
  assert.equal(toasts[0]!.signal.status, 'completed'); assert.equal(toasts[0]!.text, '메인 작업 완료 😀');
  assert.equal(observer.snapshot().connections[0]!.activeTurns, 0);
  assert.equal(Buffer.concat(bytes).toString('utf8'), [...firstEvents, ...finalEvents].map(event => JSON.stringify(event) + '\n').join(''));
  assert.equal(child.killed, false); assert.equal(diagnostics.entries.length, 0);
});

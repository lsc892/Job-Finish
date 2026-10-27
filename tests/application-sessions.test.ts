import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationSessions } from '../src/application/sessions';
import type { SavedSession, SessionLease } from '../src/application/sessions';
import { Diagnostics } from '../src/core/model';
import type { Checkpoint, SessionBinding, Signal } from '../src/core/model';
import type { Session } from '../src/core/session';
import type { AgentExecution, ExecutionContext } from '../src/runtime/agent-provider';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function execution(dispose: () => void, session?: Session) {
  return { session, run: async (_prompt: string) => {}, cancel: async () => {}, reconnect: async () => {},
    respond: (_id: string, _answer: unknown) => {}, readResult: async (_id: string) => undefined, dispose };
}
function harness(create: (context: ExecutionContext) => AgentExecution, options: {
  limits?: Record<string, number>;
  claim?: (binding: SessionBinding) => SessionLease;
  save?: (records: SavedSession[]) => PromiseLike<void>;
  saved?: SavedSession[];
  trusted?: boolean;
} = {}) {
  const events: string[] = [];
  const diagnostics = new Diagnostics();
  const signals: { signal: Signal; owned: boolean }[] = [];
  const leases: { lease: SessionLease; released: boolean; checkpoints: Checkpoint[] }[] = [];
  let saved = options.saved ?? [];
  let changes = 0;
  const sessions = new ApplicationSessions({
    windowInstanceId: 'window', diagnostics,
    trusted: () => options.trusted ?? true,
    config: (key, fallback) => (options.limits?.[key] ?? fallback) as typeof fallback,
    provider: id => {
      events.push(`provider:${id}`);
      return { runtimeId: () => 'runtime', createExecution: create };
    },
    claim: binding => {
      events.push(`claim:${binding.sessionId}`);
      if (options.claim) return options.claim(binding);
      const state = { lease: undefined as unknown as SessionLease, released: false, checkpoints: [] as Checkpoint[] };
      state.lease = {
        valid: () => !state.released,
        load: () => undefined,
        save: checkpoint => { state.checkpoints.push(checkpoint); },
        release: () => { events.push(`release:${binding.sessionId}`); state.released = true; },
      };
      leases.push(state);
      return state.lease;
    },
    saved: () => saved,
    save: records => {
      events.push('save');
      if (options.save) return options.save(records);
      saved = records;
      return Promise.resolve();
    },
    signal: signal => signals.push({ signal, owned: sessions.owns(signal.sessionId) }),
    changed: () => { changes++; },
    released: () => { events.push('released'); },
  });
  return { sessions, events, diagnostics, signals, leases, saved: () => saved, changes: () => changes };
}

test('Async open registers ownership before an initial reconciled result and preserves the saved-session bound', async () => {
  const connected = deferred();
  const previous = Array.from({ length: 32 }, (_, index) => ({ provider: 'sample', cwd: 'old', sessionId: `old-${index}` }));
  const h = harness(context => {
    const owned = { ...execution(() => h.events.push('dispose')), open: async () => {
      owned.session = context.createSession('thread', 'connection');
      assert.equal(h.sessions.has('sample', 'thread'), true);
      assert.equal(h.sessions.has('other', 'thread'), false);
      owned.session.start('turn', 'connection');
      owned.session.finish('turn', 'completed', 'connection');
      await connected.promise;
    } };
    return owned;
  }, { saved: previous });
  const pending = h.sessions.open('sample', 'workspace');
  const earlyEntry = h.sessions.get('thread');
  assert.equal(h.sessions.snapshot().length, 1);
  assert.equal(h.signals.length, 1);
  assert.equal(h.signals[0]?.owned, true);
  connected.resolve();
  const entry = await pending;
  assert.equal(entry, earlyEntry);
  assert.equal(h.sessions.get('thread'), entry);
  assert.equal(h.sessions.saved().length, 32);
  assert.equal(h.saved()[0]?.sessionId, 'old-1');
  assert.deepEqual(h.saved().at(-1), { provider: 'sample', cwd: 'workspace', sessionId: 'thread' });
  h.sessions.detach(entry);
  assert.equal(h.sessions.owns('thread'), false);
  assert.deepEqual(h.events.slice(-3), ['dispose', 'release:thread', 'released']);
});

test('A synchronous factory binds a Session before returning its execution and keeps snapshot and pending requests available', async () => {
  const h = harness(context => {
    const session = context.createSession(context.sessionId ?? 'thread', 'connection');
    // Factories create the execution before connecting; constructor-time events are not admitted.
    assert.equal(h.sessions.get('thread'), undefined);
    return execution(() => h.events.push('dispose'), session);
  }, { saved: [{ provider: 'sample', cwd: 'old', sessionId: 'thread' }] });
  const pending = h.sessions.open('sample', 'workspace', 'thread');
  assert.equal(h.sessions.owns('thread'), true);
  const entry = await pending;
  entry.session.start('turn', 'connection');
  entry.session.waiting({ id: 'question', turnId: 'turn', connectionId: 'connection', kind: 'question', title: 'Choose', payload: {} });
  assert.equal(h.sessions.pendingRequests, 1);
  assert.equal(h.sessions.snapshot()[0]?.pending, 1);
  assert.deepEqual([...h.sessions.values()], [entry]);
  assert.deepEqual(h.saved(), [{ provider: 'sample', cwd: 'workspace', sessionId: 'thread' }]);
  await assert.rejects(h.sessions.open('sample', 'workspace', 'thread'), /already connected/);
  h.sessions.dispose();
  h.sessions.dispose();
  assert.equal(h.leases[0]?.released, true);
  assert.equal(h.events.filter(event => event === 'dispose').length, 1);
  assert.equal(h.sessions.pendingRequests, 0);
});

for (const limit of ['maxSessions', 'maxConnections']) {
  test(`${limit} includes concurrent opens and a rejected open releases its capacity`, async () => {
    const gates = [deferred(), deferred()];
    let created = 0;
    const h = harness(context => {
      const index = created++;
      const owned = { ...execution(() => {}), open: async () => {
        await gates[index]!.promise;
        owned.session = context.createSession(`thread-${index}`, `connection-${index}`);
      } };
      return owned;
    }, { limits: { maxSessions: 8, maxConnections: 8, [limit]: 1 } });
    const first = h.sessions.open('sample', 'workspace');
    const rejected = assert.rejects(first, /connect failed/);
    await assert.rejects(h.sessions.open('sample', 'workspace'), /limit reached/);
    assert.equal(created, 1);
    gates[0]!.reject(new Error('connect failed'));
    await rejected;
    const second = h.sessions.open('sample', 'workspace');
    gates[1]!.resolve();
    await second;
    assert.equal(created, 2);
    h.sessions.dispose();
  });
}

test('Untrusted workspaces reject before selecting a provider or acquiring resources', async () => {
  const h = harness(() => { throw new Error('must not create'); }, { trusted: false });
  await assert.rejects(h.sessions.open('sample', 'workspace'), /Trust the workspace/);
  assert.deepEqual(h.events, []);
});

for (const stage of ['claim', 'load', 'factory', 'open', 'save', 'missing-session'] as const) {
  test(`An open failure at ${stage} removes registration, releases the lease and restores capacity`, async () => {
    let fail = true;
    let released = 0;
    let disposed = 0;
    const original = new Error(`${stage} failed`);
    const h = harness(context => {
      const owned = { ...execution(() => { disposed++; h.events.push('dispose'); }), open: async () => {
        if (fail && stage === 'missing-session') return;
        owned.session = context.createSession('thread', 'connection');
        if (fail && stage === 'open') throw original;
      } };
      if (fail && stage === 'factory') {
        context.createSession('thread', 'connection');
        throw original;
      }
      return owned;
    }, {
      limits: { maxSessions: 1, maxConnections: 1 },
      claim: () => {
        if (fail && stage === 'claim') throw original;
        let active = true;
        return {
          valid: () => active,
          load: () => { if (fail && stage === 'load') throw original; return undefined; },
          save: () => {},
          release: () => {
            if (fail) assert.equal(h.sessions.get('thread'), undefined);
            active = false;
            released++;
          },
        };
      },
      save: async () => { if (fail && stage === 'save') throw original; },
    });
    await assert.rejects(h.sessions.open('sample', 'workspace'), error => stage === 'missing-session'
      ? error instanceof Error && /did not create a session/.test(error.message) : error === original);
    assert.deepEqual(h.sessions.snapshot(), []);
    assert.equal(disposed, stage === 'factory' ? 0 : 1);
    assert.equal(released, stage === 'claim' || stage === 'missing-session' ? 0 : 1);
    fail = false;
    await h.sessions.open('sample', 'workspace');
    h.sessions.dispose();
  });
}

test('An execution disposal failure during failed open cannot skip lease release or replace the original failure', async () => {
  const original = new Error('connection failed');
  const h = harness(context => {
    const owned = { ...execution(() => { h.events.push('dispose'); throw new Error('dispose failed'); }), open: async () => {
      owned.session = context.createSession('thread', 'connection');
      throw original;
    } };
    return owned;
  });
  await assert.rejects(h.sessions.open('sample', 'workspace'), error => error === original);
  assert.deepEqual(h.events.slice(-2), ['dispose', 'release:thread']);
  assert.equal(h.leases[0]?.released, true);
  assert.deepEqual(h.sessions.snapshot(), []);
  assert.match(JSON.stringify(h.diagnostics.entries), /dispose failed/);
});

for (const stage of ['before-session', 'after-session', 'saving'] as const) {
  test(`Dispose owns in-flight resources ${stage} and prevents late registration or successful open`, async () => {
    const gate = deferred();
    const h = harness(context => {
      const owned = { ...execution(() => h.events.push('dispose')), open: async () => {
        if (stage === 'before-session') await gate.promise;
        owned.session = context.createSession('thread', 'connection');
        if (stage === 'after-session') await gate.promise;
      } };
      return owned;
    }, { save: async () => { await gate.promise; } });
    const pending = h.sessions.open('sample', 'workspace');
    const rejected = assert.rejects(pending, /Extension deactivated/);
    if (stage === 'saving') await Promise.resolve();
    assert.equal(h.sessions.snapshot().length, stage === 'before-session' ? 0 : 1);
    h.sessions.dispose();
    h.sessions.dispose();
    assert.equal(h.events.filter(event => event === 'dispose').length, 1);
    assert.equal(h.sessions.owns('thread'), false);
    if (stage !== 'before-session') assert.equal(h.leases[0]?.released, true);
    gate.resolve();
    await rejected;
    assert.deepEqual(h.sessions.snapshot(), []);
    assert.equal(h.events.filter(event => event === 'dispose').length, 1);
    assert.equal(h.changes(), 0);
    await assert.rejects(h.sessions.open('sample', 'workspace'), /Extension deactivated/);
    if (stage === 'before-session') assert.equal(h.leases.length, 0);
  });
}

test('Detach still releases the lease and invokes the release callback when execution disposal throws', async () => {
  const h = harness(context => execution(() => { throw new Error('dispose failed'); }, context.createSession('thread', 'connection')));
  const entry = await h.sessions.open('sample', 'workspace');
  assert.throws(() => h.sessions.detach(entry), /dispose failed/);
  assert.equal(h.leases[0]?.released, true);
  assert.deepEqual(h.sessions.snapshot(), []);
  assert.equal(h.events.at(-1), 'released');
  h.sessions.dispose();
});

test('An entry retained by an old picker cannot detach a replacement connection with the same session ID', async () => {
  let disposed = 0;
  const h = harness(context => execution(() => { disposed++; }, context.createSession('thread', 'connection')));
  const previous = await h.sessions.open('sample', 'workspace');
  h.sessions.detach(previous);
  const current = await h.sessions.open('sample', 'workspace', 'thread');
  h.sessions.detach(previous);
  assert.equal(h.sessions.get('thread'), current);
  assert.equal(h.sessions.owns('thread'), true);
  assert.equal(h.leases[1]?.released, false);
  assert.equal(disposed, 1);
  h.sessions.detach(current);
  assert.equal(disposed, 2);
  assert.equal(h.leases[1]?.released, true);
});

// Exercise OAuth notifications through the owned SDK Query boundary, without signing in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CanUseTool, Query, SDKMessage, SDKResultMessage, query } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { ClaudeExecution } from '../src/runtime/claude';
import { Session } from '../src/core/session';
import { Diagnostics, Signal } from '../src/core/model';
import { binding } from './helpers';

const refreshFailure = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again';
const alternateFailure = 'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh). Please try again in a minute.';

async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('OAuth SDK fixture timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fixture() {
  let owns = true;
  const signals: Signal[] = [];
  const observed: SDKMessage[] = [];
  const session = new Session(binding({ provider: 'claude' }), () => owns, () => {}, signal => signals.push(signal), new Diagnostics());
  const queries: { permission: CanUseTool; emit: (message: SDKMessage) => void; end: () => void; closed: boolean }[] = [];
  const createQuery: typeof query = ({ options }) => {
    const messages: SDKMessage[] = [];
    let ended = false;
    let wake = () => {};
    const control = {
      permission: options!.canUseTool!,
      emit: (message: SDKMessage) => { messages.push(message); wake(); },
      end: () => { ended = true; wake(); },
      closed: false,
    };
    async function* stream() {
      while (true) {
        if (messages.length) yield messages.shift()!;
        else if (ended) return;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    }
    queries.push(control);
    return Object.assign(stream(), {
      close: () => { control.closed = true; control.end(); },
      interrupt: async () => {},
    }) as unknown as Query;
  };
  const execution = new ClaudeExecution({ cwd: process.cwd(), maxTurns: 2, session, resume: false, createQuery,
    onEvent: message => observed.push(message) });
  const assistant = (text = refreshFailure, overrides: Record<string, unknown> = {}): SDKMessage => ({
    type: 'assistant', error: 'server_error', parent_tool_use_id: null,
    session_id: session.binding.sessionId, uuid: randomUUID(),
    message: { role: 'assistant', content: [{ type: 'text', text }] }, ...overrides,
  }) as unknown as SDKMessage;
  const result = (body = refreshFailure, success = false): SDKResultMessage => ({
    type: 'result', subtype: success ? 'success' : 'error_during_execution', is_error: !success,
    session_id: session.binding.sessionId, uuid: randomUUID(), user_message_uuid: [...session.turns.keys()][0],
    ...(success ? { result: body } : { errors: [body] }),
  }) as unknown as SDKResultMessage;
  return { execution, session, signals, observed, queries, assistant, result, revoke: () => { owns = false; } };
}

function ask(permission: CanUseTool, id = 'approval-1') {
  return permission('Bash', { command: 'echo OAuth fixture' }, {
    signal: new AbortController().signal, requestId: id, toolUseID: `tool-${id}`,
  });
}

test('Owned Claude OAuth notice preserves execution and pending approval until a matching result', async t => {
  const f = fixture(); t.after(() => f.execution.dispose());
  await f.execution.run('Refresh the account');
  const q = f.queries[0]!;
  const permission = ask(q.permission);
  const turnId = [...f.session.turns.keys()][0]!;
  const before = structuredClone(f.session.checkpoint());
  q.emit(f.assistant());
  await until(() => f.signals.length === 2);
  const notice = f.signals[1]!;
  assert.equal(notice.status, 'error');
  assert.equal(notice.text, refreshFailure);
  assert.equal(notice.title, 'Refresh the account');
  assert.equal(notice.turnId, turnId);
  assert.match(notice.detail!, /OAuth.*refresh/i);
  assert.deepEqual(f.session.checkpoint(), before);
  assert.equal(f.session.requests.size, 1);
  assert.equal(q.closed, false);
  q.emit(f.assistant()); q.emit(f.assistant(alternateFailure));
  await until(() => f.observed.length === 3);
  assert.equal(f.signals.filter(signal => signal.status === 'error').length, 1);
  q.emit(f.result());
  await until(() => f.session.turns.size === 0);
  assert.equal((await permission)?.behavior, 'deny');
  assert.equal(f.session.requests.size, 0);
  assert.equal(f.session.completed.get(turnId), 'error');
  assert.equal(f.signals.length, 2);
  assert.equal(q.closed, false);
  q.emit(f.assistant());
  await until(() => f.observed.length === 5);
  assert.equal(f.signals.length, 2);
});

test('Owned Claude accepts the alternate refresh-lock wording', async t => {
  const f = fixture(); t.after(() => f.execution.dispose());
  await f.execution.run('Alternate wording');
  f.queries[0]!.emit(f.assistant(alternateFailure));
  await until(() => f.signals.length === 1);
  assert.equal(f.signals[0]!.status, 'error');
  assert.equal(f.signals[0]!.text, alternateFailure);
  assert.equal([...f.session.turns.values()][0]!.status, 'running');
});

for (const outcome of ['success', 'different error'] as const) {
  test(`Owned Claude still delivers ${outcome} after a refresh-lock notice`, async t => {
    const f = fixture(); t.after(() => f.execution.dispose());
    await f.execution.run('Continue after refresh');
    const q = f.queries[0]!;
    q.emit(f.assistant());
    await until(() => f.signals.length === 1);
    q.emit(f.result(outcome === 'success' ? 'Account refreshed successfully' : 'A different execution failure', outcome === 'success'));
    await until(() => f.signals.length === 2);
    assert.equal(f.signals[1]!.status, outcome === 'success' ? 'completed' : 'error');
    assert.equal(f.signals[1]!.text, outcome === 'success' ? 'Account refreshed successfully' : 'A different execution failure');
    assert.equal(f.session.turns.size, 0);
    assert.equal(f.session.completed.size, 1);
  });
}

test('Owned Claude reports a refresh-lock result even without an earlier assistant notice', async t => {
  const f = fixture(); t.after(() => f.execution.dispose());
  await f.execution.run('Result only');
  f.queries[0]!.emit(f.result());
  await until(() => f.signals.length === 1);
  assert.equal(f.signals[0]!.status, 'error');
  assert.equal(f.signals[0]!.text, refreshFailure);
  assert.match(f.signals[0]!.detail!, /OAuth.*refresh/i);
  assert.equal(f.session.turns.size, 0);
});

test('Owned Claude refresh-lock deduplication is scoped to each execution', async t => {
  const f = fixture(); t.after(() => f.execution.dispose());
  await f.execution.run('First execution');
  const first = f.queries[0]!;
  first.emit(f.assistant()); first.emit(f.result());
  await until(() => f.session.turns.size === 0);
  first.end(); await until(() => first.closed);
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.execution.run('Second execution');
  assert.equal((await ask(first.permission, 'stale-request'))?.behavior, 'deny');
  assert.equal(f.session.requests.size, 0);
  first.emit(f.assistant());
  f.queries[1]!.emit(f.assistant());
  await until(() => f.signals.length === 2);
  assert.equal(f.signals[0]!.title, 'First execution');
  assert.equal(f.signals[1]!.title, 'Second execution');
  assert.notEqual(f.signals[0]!.turnId, f.signals[1]!.turnId);
  assert.notEqual(f.signals[0]!.notificationId, f.signals[1]!.notificationId);
});

for (const loss of ['ownership', 'connection'] as const) {
  test(`Owned Claude ignores OAuth notices after ${loss} changes`, async t => {
    const f = fixture(); t.after(() => f.execution.dispose());
    await f.execution.run('Ownership guard');
    const q = f.queries[0]!;
    if (loss === 'ownership') f.revoke(); else f.session.reconnect('replacement-connection');
    q.emit(f.assistant());
    await until(() => f.observed.length === 1);
    assert.equal(f.signals.length, 0);
    assert.equal([...f.session.turns.values()][0]!.status, 'running');
    assert.equal(f.session.completed.size, 0);
    assert.equal((await ask(q.permission, 'late-request'))?.behavior, 'deny');
  });
}

test('Owned Claude ignores quoted, subagent, and unrelated errors', async t => {
  const f = fixture(); t.after(() => f.execution.dispose());
  await f.execution.run('Avoid false alarms');
  const q = f.queries[0]!;
  const ignored = [
    f.assistant(refreshFailure, { error: undefined }),
    f.assistant(refreshFailure, { type: 'user' }),
    f.assistant(refreshFailure, { parent_tool_use_id: 'subagent-tool' }),
    f.assistant(refreshFailure, { error: 'authentication_failed' }),
    f.assistant('An unrelated server failure'),
    f.assistant(refreshFailure, { message: { content: [{ type: 'tool_result', content: refreshFailure }] } }),
  ];
  for (const message of ignored) q.emit(message);
  await until(() => f.observed.length === ignored.length);
  assert.equal(f.signals.length, 0);
  assert.equal([...f.session.turns.values()][0]!.status, 'running');
  q.emit(f.assistant());
  await until(() => f.signals.length === 1);
  assert.equal(f.signals[0]!.text, refreshFailure);
});

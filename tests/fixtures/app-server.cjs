// Deterministic wire fixture: the product still uses its real stdio transport and adapter.
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const storage = process.env.JOB_FINISH_FIXTURE_STORAGE;
const file = id => join(storage, `${id}.json`);
const save = thread => { if (storage) writeFileSync(file(thread.id), JSON.stringify(thread)); };
const load = id => { if (storage && id && /^[a-f0-9-]+$/i.test(id)) { try { return JSON.parse(readFileSync(file(id), 'utf8')); } catch {} } };
function syntheticHistory(id) {
  if (!id?.startsWith('history-')) return;
  const turns = id === 'history-large' ? Array.from({ length: 600 }, (_, i) => ({ id: `old-${i}`, status: 'completed', items: [{ type: 'agentMessage', id: `answer-${i}`, phase: 'final_answer', text: 'x'.repeat(4096) + i }] })) :
    [{ id: 'recovered-turn', status: id === 'history-incomplete' ? 'inProgress' : 'completed', items: [{ type: 'userMessage', id: 'user', clientId: 'recover-request', content: [] },
      { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'RECOVERED_' + 'y'.repeat(20_000) }] }];
  return { id, turns, status: { type: 'idle' } };
}
const threads = new Map();
let initialized = false; let active;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({ method, params });
function finish(status = 'completed', text = 'FIXTURE_RESULT') {
  if (!active) return;
  const { thread, turn } = active;
  turn.status = status; turn.items = [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text }];
  thread.status = { type: 'idle' };
  save(thread);
  event('item/completed', { threadId: thread.id, turnId: turn.id, item: turn.items[0] });
  event('turn/completed', { threadId: thread.id, turn });
  event('turn/completed', { threadId: thread.id, turn }); active = undefined;
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); const p = m.params ?? {};
  if (m.method === 'initialize') { initialized = true; send({ id: m.id, result: { userAgent: 'fixture' } }); return; }
  if (m.method === 'initialized') return;
  if (!initialized) throw new Error('Initialize required');
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    const thread = threads.get(p.threadId) ?? load(p.threadId) ?? syntheticHistory(p.threadId) ?? { id: p.threadId ?? randomUUID(), turns: [], status: { type: 'idle' } };
    const turn = thread.turns.find(t => t.status === 'inProgress'); if (turn && thread.status.type === 'active') active = { thread, turn };
    threads.set(thread.id, thread); send({ id: m.id, result: { thread: p.excludeTurns ? { ...thread, turns: [] } : thread, model: 'fixture-model' } }); return;
  }
  if (m.method === 'thread/read') { const thread = threads.get(p.threadId); send({ id: m.id, result: { thread: p.includeTurns ? thread : { ...thread, turns: [] } } }); return; }
  if (m.method === 'thread/turns/list') {
    const thread = threads.get(p.threadId); const turns = [...thread.turns].reverse(); const offset = Number(p.cursor ?? 0);
    const data = turns.slice(offset, offset + p.limit).map(t => p.itemsView === 'notLoaded' ? { ...t, items: [], itemsView: 'notLoaded' } : t);
    send({ id: m.id, result: { data, nextCursor: offset + data.length < turns.length ? String(offset + data.length) : null, backwardsCursor: null } }); return;
  }
  if (m.method === 'thread/items/list') {
    const thread = threads.get(p.threadId); const turn = thread.turns.find(t => t.id === p.turnId);
    const items = [...(turn?.items ?? [])]; if (p.sortDirection === 'desc') items.reverse();
    const offset = Number(p.cursor ?? 0); const data = items.slice(offset, offset + p.limit).map(item => ({ turnId: p.turnId, item, startedAtMs: null, completedAtMs: null }));
    send({ id: m.id, result: { data, nextCursor: offset + data.length < items.length ? String(offset + data.length) : null, backwardsCursor: null } }); return;
  }
  if (m.method === 'turn/start') {
    if (p.input[0].text === 'reject-start') { send({ id: m.id, error: { code: -32000, message: 'Start rejected' } }); return; }
    const thread = threads.get(p.threadId); const turn = { id: randomUUID(), status: 'inProgress', items: [] };
    thread.turns.push(turn); active = { thread, turn };
    thread.status = { type: 'active', activeFlags: [] };
    save(thread);
    // Event can precede the request response.
    event('turn/started', { threadId: thread.id, turn }); send({ id: m.id, result: { turn } });
    const text = p.input[0].text;
    if (text === 'disconnect') { process.exit(0); return; }
    if (text === 'approval') { send({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, command: 'echo fixture' } }); return; }
    if (text === 'question') { send({ id: 43, method: 'item/tool/requestUserInput', params: { threadId: thread.id, turnId: turn.id, questions: [{ id: 'q', question: 'Pick a color', options: [{ label: 'Blue' }] }] } }); return; }
    if (text === 'permissions') { send({ id: 44, method: 'item/permissions/requestApproval', params: { threadId: thread.id, turnId: turn.id, reason: 'Write a marker', permissions: { network: null, fileSystem: { read: null, write: ['C:\\fixture'] } } } }); return; }
    if (text === 'wait') return;
    setTimeout(() => finish(text === 'fail' ? 'failed' : 'completed', text), 50); return;
  }
  if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); finish('interrupted', ''); return; }
  if (m.id === 42 || m.id === 43 || m.id === 44) {
    event('serverRequest/resolved', { threadId: active.thread.id, requestId: m.id });
    finish('completed', JSON.stringify(m.result)); return;
  }
  send({ id: m.id, error: { code: -32601, message: 'Fixture method unsupported' } });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexHistory } from '../src/runtime/codex-history';
import { StdioRpc } from '../src/runtime/transport';

function history(reply: (params: unknown) => unknown, check = () => {}) {
  return new CodexHistory({ request: async (_method, params) => reply(params) } as Pick<StdioRpc, 'request'>, 'thread', check);
}
test('History rejects repeated cursors and mismatched turn items', async () => {
  await assert.rejects(() => history(() => ({ data: [], nextCursor: 'same' })).turns(), /repeated/);
  await assert.rejects(() => history(() => ({ data: [{ turnId: 'other', item: { type: 'agentMessage', phase: 'final_answer', text: 'wrong' } }], nextCursor: null })).finalText('turn'), /another turn/);
});
test('History ignores commentary, finds the latest final response, and verifies connection after awaiting RPC', async () => {
  const h = history(() => ({ data: [{ turnId: 'turn', item: { type: 'agentMessage', phase: 'commentary', text: 'progress' } },
    { turnId: 'turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'final' } }], nextCursor: null }));
  assert.equal(await h.finalText('turn'), 'final');
  let connected = true;
  const stale = history(() => { connected = false; return { data: [], nextCursor: null }; }, () => { if (!connected) throw new Error('Connection replaced'); });
  await assert.rejects(() => stale.turns(), /replaced/);
});
test('Empty or excessive history pages cannot cause an unbounded lookup', async () => {
  let calls = 0;
  const h = history(() => ({ data: [], nextCursor: String(++calls) }));
  await assert.rejects(() => h.turns(), /64-page/); assert.equal(calls, 64);
  await assert.rejects(() => history(() => ({ data: Array(33).fill({ id: 'turn' }), nextCursor: null })).turns(), /Invalid/);
});

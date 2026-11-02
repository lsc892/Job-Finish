// Codex 이력의 페이지 상한·커서 검증·최종 응답 선택과 연결 유효성 확인을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexHistory } from '../src/runtime/codex/history';
import { StdioRpc } from '../src/runtime/transport';
import { LIMITS } from '../src/core/model';

function history(reply: (params: unknown) => unknown, check = () => {}) {
  return new CodexHistory({ request: async (_method, params) => reply(params) } as Pick<StdioRpc, 'request'>, 'thread', check);
}
test('History rejects repeated cursors and mismatched turn items', async () => {
  await assert.rejects(() => history(() => ({ data: [], nextCursor: 'same' })).turns(), /repeated/);
  await assert.rejects(() => history(() => ({ data: [{ turnId: 'other', item: { type: 'agentMessage', phase: 'final_answer', text: 'wrong' } }], nextCursor: null })).finalText('turn'), /another turn/);
});
test('History ignores commentary and async questions, finds the final response, and verifies the connection', async () => {
  const h = history(() => ({ data: [{ turnId: 'turn', item: { type: 'agentMessage', phase: 'commentary', text: 'progress' } },
    { turnId: 'turn', item: { type: 'agentMessage', phase: 'final_answer', delivery: 'async', text: 'question widget payload', questions: [{ title: 'Pick a color?', options: null }] } },
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

test('Turn history strips embedded items but rejects repeated IDs and excessive metadata', async () => {
  const embedded = { id: 'turn', status: 'completed', items: [{ text: 'x'.repeat(LIMITS.queueBytes) }] };
  const result = await history(() => ({ data: [embedded], nextCursor: null })).turns();
  assert.deepEqual(result.turns, [{ id: 'turn', status: 'completed', items: [] }]);

  let page = 0;
  await assert.rejects(() => history(() => ({
    data: [{ id: 'same', items: [] }], nextCursor: ++page === 1 ? 'next' : null,
  })).turns(), /repeated Codex history turn/);
  await assert.rejects(() => history(() => ({
    data: [{ id: 'turn', error: { message: 'x'.repeat(LIMITS.queueBytes) } }], nextCursor: null,
  })).turns(), /metadata exceeds 4 MiB/);
});

test('Turn and item lookups share the 64-page budget and retain their scan directions', async () => {
  const requests: { method: string; params: { sortDirection: string } }[] = [];
  const rpc = { request: async (method: string, params: { sortDirection: string }) => {
    requests.push({ method, params });
    if (method === 'thread/turns/list') return { data: [], nextCursor: requests.length < 63 ? String(requests.length) : null };
    return { data: [{ turnId: 'turn', item: { type: 'userMessage', clientId: 'request' } }], nextCursor: null };
  } } as unknown as Pick<StdioRpc, 'request'>;
  const h = new CodexHistory(rpc, 'thread', () => {});
  await h.turns();
  assert.equal(await h.matchesStart('turn', 'request'), true);
  assert.equal(requests.length, 64);
  assert.equal(requests[0]!.params.sortDirection, 'desc');
  assert.equal(requests[63]!.params.sortDirection, 'asc');
  await assert.rejects(() => h.finalText('turn'), /64-page/);
  assert.equal(requests.length, 64);

  let direction: unknown;
  await history(params => {
    direction = (params as { sortDirection: string }).sortDirection;
    return { data: [], nextCursor: null };
  }).finalText('turn');
  assert.equal(direction, 'desc');
});

test('Turn history reports truncation at 512 entries while unfinished item scans reject at that limit', async () => {
  let turnPages = 0;
  const turns = await history(() => ({
    data: Array.from({ length: 32 }, (_, index) => ({ id: `turn-${turnPages}-${index}`, items: [] })),
    nextCursor: String(++turnPages),
  })).turns();
  assert.equal(turnPages, 16);
  assert.equal(turns.turns.length, 512);
  assert.equal(turns.truncated, true);

  let itemPages = 0;
  await assert.rejects(() => history(() => ({
    data: Array.from({ length: 16 }, () => ({ turnId: 'turn', item: { type: 'userMessage', clientId: 'different' } })),
    nextCursor: String(++itemPages),
  })).matchesStart('turn', 'missing'), /512-item/);
  assert.equal(itemPages, 32);
});

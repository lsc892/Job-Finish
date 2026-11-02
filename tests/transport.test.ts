// UTF-8 JSONL 프레임·RPC 봉투·초기 이벤트 큐와 stdio 요청 수명을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue, JsonLines, RpcError, RpcMessage, StdioRpc } from '../src/runtime/transport';
import { LIMITS } from '../src/core/model';

test('Every UTF-8 byte/JSON boundary and multiple frames decode identically', () => {
  const expected = [{ method: 'event', params: { text: '한국어😀' } }, { id: 1, result: { text: 'ok' } }];
  const buffer = Buffer.from(expected.map(m => JSON.stringify(m)).join('\r\n') + '\n');
  for (let split = 0; split <= buffer.length; split++) {
    const messages: RpcMessage[] = []; const decoder = new JsonLines(m => messages.push(m));
    decoder.push(buffer.subarray(0, split)); decoder.push(buffer.subarray(split)); decoder.end();
    assert.deepEqual(messages, expected);
  }
});
test('Oversized/malformed/incomplete frames fail explicitly and can be cleared', () => {
  const decoder = new JsonLines(() => {});
  assert.throws(() => decoder.push(Buffer.alloc(LIMITS.messageBytes + 1, 65)), /exceeds/); decoder.clear();
  assert.throws(() => decoder.push(Buffer.from('{bad}\n')), SyntaxError); decoder.clear();
  decoder.push(Buffer.from('{')); assert.throws(() => decoder.end(), /EOF/); decoder.clear(); assert.equal(decoder.bufferedBytes, 0);
});
test('Corrupt RPC envelopes fail instead of silently losing a control event', () => {
  for (const value of [{ method: 5 }, { id: true, result: {} }, { id: 1 }, { method: 'turn/completed', result: {} }]) {
    const decoder = new JsonLines(() => assert.fail('Invalid message was delivered'));
    assert.throws(() => decoder.push(Buffer.from(JSON.stringify(value) + '\n')), /Invalid JSON-RPC/);
  }
});
test('Initialization queue bounds count and total bytes, preserving order', () => {
  const queue = new EventQueue(); for (let i = 0; i < LIMITS.queueCount; i++) queue.push({ id: i });
  assert.throws(() => queue.push({ id: 513 }), /overflow/); const ids: unknown[] = []; queue.drain(m => ids.push(m.id)); assert.equal(ids[0], 0); assert.equal(ids.at(-1), 511); assert.equal(queue.size, 0);
  queue.push({ params: 'x'.repeat(3 * 1024 * 1024) }); assert.throws(() => queue.push({ params: 'x'.repeat(2 * 1024 * 1024) }), /overflow/); queue.clear();
});
test('Real stdio RPC matches responses and rejects pending requests on EOF', async () => {
  let disconnected = '';
  const rpc = new StdioRpc(() => {}, error => { disconnected = error.message; }, () => {});
  rpc.start(process.execPath, ['-e', "process.stdin.once('data', chunk => { const m=JSON.parse(chunk); process.stdout.write(JSON.stringify({id:m.id,result:'ok'})+'\\n'); process.exitCode=0; process.stdin.destroy(); })"], process.cwd());
  assert.equal(await rpc.request('initialize', {}), 'ok');
  await new Promise(resolve => setTimeout(resolve, 150)); assert.match(disconnected, /EOF|exited/); rpc.dispose();
});

test('RPC matches out-of-order responses, preserves false results and reports unknown responses', async t => {
  const messages: RpcMessage[] = [];
  const diagnostics: string[] = [];
  const rpc = new StdioRpc(message => messages.push(message), () => {}, message => diagnostics.push(message));
  t.after(() => rpc.dispose());
  const child = `
    const requests = [];
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      requests.push(JSON.parse(line));
      if (requests.length !== 2) return;
      send({ id: 'unknown', result: null });
      send({ method: 'progress', params: { value: 1 } });
      send({ id: requests[1].id, result: false });
      send({ id: requests[0].id, error: { code: -32000, message: 'Controlled RPC error' } });
    });
  `;
  rpc.start(process.execPath, ['-e', child], process.cwd());
  const failure = assert.rejects(rpc.request('first', {}), error =>
    error instanceof RpcError && error.code === -32000 && error.message === 'Controlled RPC error');
  assert.equal(await rpc.request('second', {}), false);
  await failure;
  assert.deepEqual(messages, [{ method: 'progress', params: { value: 1 } }]);
  assert.deepEqual(diagnostics, ['Response to unknown RPC request']);
  assert.equal(rpc.connected, true);
});

test('A timed-out RPC rejects its own request specifically and closes other pending requests once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const disconnects: Error[] = [];
  const rpc = new StdioRpc(() => {}, error => disconnects.push(error), () => {});
  t.after(() => rpc.dispose());
  rpc.start(process.execPath, ['-e', 'process.stdin.resume()'], process.cwd());
  const first = rpc.request('first', {});
  t.mock.timers.tick(10_000);
  const second = rpc.request('second', {});
  const outcomes = Promise.allSettled([first, second]);
  t.mock.timers.tick(19_999);
  assert.equal(rpc.connected, true);
  assert.equal(disconnects.length, 0);
  t.mock.timers.tick(1);
  const results = await outcomes;
  assert.deepEqual(results.map(result => result.status === 'rejected' ? result.reason.message : 'resolved'),
    ['RPC timeout: first; outcome unknown', 'Connection closed; outcome unknown']);
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0]!.message, 'RPC timeout: first; outcome unknown');
  assert.equal(rpc.connected, false);
  t.mock.timers.tick(30_000);
  assert.equal(disconnects.length, 1);
});

test('RPC pending capacity rejects only the excess request and disposal settles every admitted request', async t => {
  const rpc = new StdioRpc(() => {}, () => {}, () => {});
  t.after(() => rpc.dispose());
  rpc.start(process.execPath, ['-e', 'process.stdin.resume()'], process.cwd());
  const pending = Array.from({ length: LIMITS.requests }, () => rpc.request('held', {}));
  const outcomes = Promise.allSettled(pending);
  await assert.rejects(rpc.request('excess', {}), /RPC pending request limit exceeded/);
  assert.equal(rpc.connected, true);
  rpc.dispose();
  const results = await outcomes;
  assert.equal(results.length, LIMITS.requests);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'Connection closed; outcome unknown'));
  await assert.rejects(rpc.request('after-dispose', {}), /Connection closed/);
});

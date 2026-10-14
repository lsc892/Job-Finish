import test from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue, JsonLines, RpcMessage, StdioRpc } from '../src/runtime/transport';
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

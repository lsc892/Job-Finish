// 알림 활성화 채널의 연결 상한·유휴 종료·만료와 현재 소유권 확인을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, Socket } from 'node:net';
import { Diagnostics } from '../src/core/model';
import { ToastActivation } from '../src/windows/toast-activation';

async function client(pipe: string): Promise<Socket> {
  const socket = connect(`\\\\.\\pipe\\${pipe}`);
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}
function setup(expired?: () => void) {
  let current = true;
  const activation = new ToastActivation({ notificationId: 'click', windowInstanceId: 'window', title: 'title', message: 'message', appId: 'JobFinish.VSCode' },
    new Diagnostics(), () => current, () => expired?.());
  const ready = new Promise<void>((resolve, reject) => activation.listen(resolve, reject));
  return { activation, ready, invalidate: () => { current = false; } };
}

test('A fifth callback connection is closed while the first four remain usable', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.activation.dispose()); await f.ready;
  const sockets: Socket[] = [];
  for (let i = 0; i < 4; i++) sockets.push(await client(f.activation.pipe));
  t.after(() => sockets.forEach(socket => socket.destroy()));
  const extra = connect(`\\\\.\\pipe\\${f.activation.pipe}`);
  extra.on('error', () => {});
  t.after(() => extra.destroy());
  await new Promise<void>(resolve => extra.once('close', resolve));
  const first = sockets[0]!;
  const reply = new Promise<string>(resolve => first.once('data', chunk => resolve(chunk.toString())));
  first.write(JSON.stringify({ event: 'toast.click', notificationId: 'click', windowInstanceId: 'window' }) + '\n');
  assert.equal(JSON.parse(await reply).allowed, true);
  assert.equal(sockets.slice(1).some(socket => socket.destroyed), false);
});

test('An idle callback socket closes after five seconds without expiring the whole channel', { skip: process.platform !== 'win32', timeout: 8000 }, async t => {
  const f = setup(); t.after(() => f.activation.dispose()); await f.ready;
  const socket = await client(f.activation.pipe); t.after(() => socket.destroy());
  await new Promise<void>(resolve => socket.once('close', resolve));
  const next = await client(f.activation.pipe); t.after(() => next.destroy());
  assert.equal(next.destroyed, false);
});

test('Channel expiry closes existing sockets after five minutes', { skip: process.platform !== 'win32' }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let expirations = 0;
  const f = setup(() => { expirations++; f.activation.dispose(); });
  t.after(() => f.activation.dispose()); await f.ready;
  const socket = await client(f.activation.pipe); t.after(() => socket.destroy());
  const closed = new Promise<void>(resolve => socket.once('close', resolve));
  t.mock.timers.tick(299_999);
  assert.equal(expirations, 0);
  t.mock.timers.tick(1);
  await closed;
  assert.equal(expirations, 1);
});

test('Activation consults current ownership when the click arrives', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(); t.after(() => f.activation.dispose()); await f.ready;
  const socket = await client(f.activation.pipe); t.after(() => socket.destroy());
  f.invalidate();
  const reply = new Promise<string>(resolve => socket.once('data', chunk => resolve(chunk.toString())));
  socket.write(JSON.stringify({ event: 'toast.click', notificationId: 'click', windowInstanceId: 'window' }) + '\n');
  assert.equal(JSON.parse(await reply).allowed, false);
});

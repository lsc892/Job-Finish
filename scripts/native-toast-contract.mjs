import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

// Exercise the compiled C# process and real pipe. These checks never focus a window.
const registration = spawnSync('dotnet', ['run', '--project', 'tests/native-toast/RegistrationTests.csproj', '-c', 'Release', '--no-launch-profile'], { stdio: 'inherit', windowsHide: true });
if (registration.error) throw registration.error;
assert.equal(registration.status, 0, 'Native shortcut migration tests must pass');
const binary = resolve('dist/native/JobFinish.Native.exe');
const run = (args, input) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Native contract timeout')); }, 15_000);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('close', code => { clearTimeout(timeout); resolve({ code, stderr, events: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [] }); });
  child.stdin.end(input);
});
const uri = request => `jobfinish-native-focus://focus/${Buffer.from(JSON.stringify(request)).toString('base64url')}`;
const request = () => ({ notificationId: randomUUID(), windowInstanceId: randomUUID(), title: '', message: '',
  appId: 'JobFinish.VSCode', pipe: `job-finish-${randomUUID()}`, expires: Math.floor(Date.now() / 1000) + 60, target: null });
assert.equal((await run([])).code, 2);
assert.equal((await run(['--uri', 'https://example.invalid/'])).code, 2);
assert.equal((await run(['--uri', uri({ ...request(), expires: 1 })])).code, 2);
assert.equal((await run(['--uri', uri({ ...request(), pipe: 'unrelated' })])).code, 2);
const badShow = await run(['--show'], JSON.stringify({ ...request(), title: '한글 알림', message: 'UTF-8 검증', appId: 'wrong' }));
assert.equal(badShow.code, 1); assert.match(badShow.stderr, /Invalid toast request/);
for (const scenario of [
  { name: 'missing-binding', target: null, allowed: true, code: 4 },
  { name: 'invalid-binding', target: { hwnd: '0', pid: process.pid, executable: process.execPath, started: 1 }, allowed: true, code: 4 },
  { name: 'ownership-denied', target: null, allowed: false, code: 3 },
]) {
  const activation = { ...request(), target: scenario.target }; const events = []; const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); let buffered = '';
    socket.on('data', chunk => {
      buffered += chunk;
      for (let newline; (newline = buffered.indexOf('\n')) >= 0;) {
        const event = JSON.parse(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1); events.push(event);
        if (event.event === 'toast.click') socket.write(JSON.stringify({ allowed: scenario.allowed }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${activation.pipe}`, resolve); });
  try {
    const result = await run(['--uri', uri(activation)]); assert.equal(result.code, scenario.code);
    assert.equal(events[0].event, 'toast.click'); assert.equal(events[0].notificationId, activation.notificationId);
    assert.equal(events[0].windowInstanceId, activation.windowInstanceId);
    if (scenario.allowed) { assert.equal(events[1].activated, false); assert.equal(events[1].reason, scenario.name); }
    else assert.equal(events.length, 1);
    console.log(`Native C# contract passed: ${scenario.name}`);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}
console.log('Native C# validation and authorization passed; no desktop activation performed.');

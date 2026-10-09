import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

// Exercise the compiled C# process and real pipe. These checks never focus a window.
const registration = spawnSync('dotnet', ['run', '--project', 'tests/native-toast/RegistrationTests.csproj', '-c', 'Release', '--no-launch-profile'], { stdio: 'inherit', windowsHide: true });
if (registration.error) throw registration.error;
assert.equal(registration.status, 0, 'Native shortcut migration tests must pass');
const comBuild = spawnSync('dotnet', ['build', 'tests/native-toast/com-activation/ComActivationTests.csproj', '-c', 'Release', '--nologo'], { stdio: 'inherit', windowsHide: true });
if (comBuild.error) throw comBuild.error;
assert.equal(comBuild.status, 0, 'COM activation test client must build');
const comClient = resolve('tests/native-toast/com-activation/bin/Release/net8.0-windows/ComActivationTests.dll');
const binary = resolve('dist/native/JobFinish.Native.exe');
const run = (args, input, executable = binary, timeoutMs = 15_000) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Native contract timeout')); }, timeoutMs);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('close', code => { clearTimeout(timeout); resolve({ code, stderr, events: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [] }); });
  child.stdin.end(input);
});
const uri = request => `jobfinish-native-focus://focus/${Buffer.from(JSON.stringify(request)).toString('base64url')}`;
const runCom = (request, appId, expectedExit, expectedHResult = 0) => run([
  comClient, binary, appId, Buffer.from(JSON.stringify(request)).toString('base64url'),
  String(expectedExit), String(expectedHResult)
], undefined, 'dotnet', 30_000);
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
  for (const transport of ['protocol', 'com']) {
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
      const result = transport === 'protocol' ? await run(['--uri', uri(activation)])
        : await runCom(activation, activation.appId, scenario.code);
      assert.equal(result.code, transport === 'protocol' ? scenario.code : 0, result.stderr);
      if (transport === 'com') {
        assert.equal(result.events[0].hresult, 0);
        assert.equal(result.events[0].helperExit, scenario.code);
      }
      assert.equal(events[0].event, 'toast.click'); assert.equal(events[0].notificationId, activation.notificationId);
      assert.equal(events[0].windowInstanceId, activation.windowInstanceId);
      if (scenario.allowed) { assert.equal(events[1].activated, false); assert.equal(events[1].reason, scenario.name); }
      else assert.equal(events.length, 1);
      console.log(`Native C# ${transport} contract passed: ${scenario.name}`);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  }
}
const wrongApp = await runCom(request(), 'Another.App', 2, 0x80070057);
assert.equal(wrongApp.code, 0, wrongApp.stderr);
assert.equal(wrongApp.events[0].hresult, 0x80070057);
assert.equal(wrongApp.events[0].helperExit, 2);
console.log('Native C# COM contract passed: wrong app rejects and helper exits.');
console.log('Native C# validation and authorization passed; no desktop activation performed.');

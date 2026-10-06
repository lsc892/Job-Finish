import { build } from 'esbuild';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = mkdtempSync(join(tmpdir(), 'job-finish-toast-'));
const baselineFile = existsSync('test-artifacts/toast-routing-baseline.json') ? `toast-routing-baseline-${Date.now()}.json` : 'toast-routing-baseline.json';
const artifactFile = process.argv.includes('--protocol') ? 'toast-protocol-routing.json' : process.argv.includes('--baseline') ? baselineFile : 'toast-routing.json';
const harness = resolve('.generated/toast-harness'); mkdirSync(harness, { recursive: true });
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(join(harness, 'package.json'), JSON.stringify({ ...manifest, main: './extension.cjs' }));
await build({ entryPoints: ['tests/toast-host.ts'], outfile: join(harness, 'extension.cjs'), platform: 'node', target: 'node22', format: 'cjs', bundle: true,
  external: ['vscode', 'koffi', '@anthropic-ai/claude-agent-sdk'] });
if (!existsSync(join(harness, 'node_modules'))) symlinkSync(resolve('node_modules'), join(harness, 'node_modules'), 'junction');
if (!existsSync(join(harness, 'dist'))) symlinkSync(resolve('dist'), join(harness, 'dist'), 'junction');
const profile = join(root, 'profile'); const extensions = join(root, 'extensions');
mkdirSync(join(profile, 'User'), { recursive: true }); mkdirSync(extensions); mkdirSync(join(root, 'workspace'));
symlinkSync(harness, join(extensions, 'lsc892.job-finish-0.1.0'), 'junction');
writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({ 'jobFinish.toast': true, 'jobFinish.flash': false,
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'extensions.autoUpdate': false }));
for (const role of ['A', 'B']) writeFileSync(join(root, `${role}.code-workspace`), JSON.stringify({ folders: [{ path: join(root, 'workspace') }] }));
const executable = process.env.JOB_FINISH_CODE_EXECUTABLE ?? join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
const env = { ...process.env, JOB_FINISH_TOAST_ARTIFACTS: root, JOB_FINISH_TEST_AGENT_ROOT: resolve('tests/fixtures') }; delete env.ELECTRON_RUN_AS_NODE;
const launch = role => spawn(executable, ['--new-window', '--user-data-dir', profile, '--extensions-dir', extensions, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', join(root, `${role}.code-workspace`)], { env, windowsHide: true, stdio: 'ignore' });
const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
const until = async fn => { const end = Date.now() + 30_000; while (!fn()) { for (const role of ['A', 'B']) if (existsSync(join(root, `${role}-error.json`))) throw new Error(JSON.stringify(read(`${role}-error.json`))); if (Date.now() > end) throw new Error(`Toast routing timeout: ${root}`); await pause(50); } };
const command = async (role, action, fields = {}) => {
  const id = randomUUID(); const file = join(root, `${role}-command.json`); writeFileSync(`${file}.tmp`, JSON.stringify({ id, action, ...fields })); renameSync(`${file}.tmp`, file);
  await until(() => existsSync(join(root, `${role}-ack.json`)) && read(`${role}-ack.json`).id === id);
  return action === 'snapshot' ? read(`${role}-${id}.json`) : undefined;
};
console.log(`Toast routing artifacts: ${root}`);
const children = [launch('A')];
const cases = [];
let lastSnapshot;
try {
  await until(() => existsSync(join(root, 'A-ready.json'))); children.push(launch('B'));
  await until(() => existsSync(join(root, 'B-ready.json')));
  const a = read('A-ready.json'); const b = read('B-ready.json');
  const focus = async target => {
    const ready = join(root, `focus-${randomUUID()}.txt`);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/focus-test-window.ps1'), '-Hwnd', target.hwnd, '-ReadyFile', ready], { windowsHide: true, stdio: 'ignore' });
    children.push(child); await until(() => existsSync(ready)); await pause(100);
  };
  const scenarios = [
    { name: 'missing-binding', unbind: true, expectedActivation: false },
    { name: 'same-title-windows', unbind: false, expectedActivation: true },
    { name: 'minimized-restore', unbind: false, expectedActivation: true, state: 'minimize' },
    { name: 'maximized-preserved', unbind: false, expectedActivation: true, state: 'maximize' },
  ];
  for (const scenario of scenarios.filter(item => !process.argv.includes('--bound-only') || !item.unbind)) {
    const { unbind } = scenario;
    if (!unbind) { await focus(a); await command('A', 'bind'); }
    if (scenario.state) { await command('A', scenario.state); await pause(150); }
    let before;
    for (let attempt = 0; attempt < 3; attempt++) {
      await focus(b); before = await command('A', 'snapshot'); lastSnapshot = before;
      if (!before.focused && before.foreground === b.hwnd) break;
    }
    if (before.focused || before.foreground !== b.hwnd) throw new Error(`Test requires B foreground and A unfocused: ${JSON.stringify({ before, a, b })}`);
    await command('A', 'emit', { unbind, turn: randomUUID() });
    const title = a.windowInstanceId.slice(0, 8);
    if (process.argv.includes('--protocol')) {
      await until(() => existsSync(join(root, 'A-ready.json')));
      await pause(800);
      const registered = await command('A', 'snapshot'); lastSnapshot = registered;
      const notificationId = registered.results.at(-1).notificationId;
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/activate-test-toast.ps1'), '-NotificationId', notificationId, '-WindowInstanceId', a.windowInstanceId], { windowsHide: true, timeout: 10_000 });
    }
    const clickArgs = ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/click-toast.ps1'), '-ToastTitle', title];
    if (process.argv.includes('--debug')) clickArgs.push('-DiagnosticFile', join(root, `click-${unbind}.jsonl`));
    let mouse; let mouseError;
    const clickProcess = process.argv.includes('--protocol') ? { kill() {} } : execFile('powershell.exe', clickArgs, { windowsHide: true, timeout: 25_000 }, (error, stdout, stderr) => {
      if (error) { mouseError = { message: error.message, stderr }; console.error(`Toast automation failed: ${stderr}`); }
      if (!error) mouse = JSON.parse(stdout.trim());
    });
    let after; let clickedAt;
    const deadline = Date.now() + 22_000;
    try {
      while (Date.now() < deadline) {
        after = await command('A', 'snapshot'); lastSnapshot = after;
        const click = after.events.find(event => event.event === 'toast.click' && event.notificationId === after.results.at(-1)?.notificationId);
        if (click) {
          clickedAt ??= Date.now();
          const result = after.events.find(event => event.event === 'window.activation.result' && event.notificationId === click.notificationId);
          if (result && Date.now() - clickedAt > 250) break;
          if (Date.now() - clickedAt > 7000) break;
        }
        await pause(50);
      }
    } finally { clickProcess.kill(); }
    if (!clickedAt) throw new Error(`No native click received: ${JSON.stringify({ mouseError, after })}`);
    const clickEvent = after.events.find(event => event.event === 'toast.click' && event.notificationId === after.results.at(-1)?.notificationId);
    const activated = after.observations.some(observation => observation.at >= clickEvent.at && observation.foreground === a.hwnd && observation.focused && !observation.minimized);
    const nativeResult = after.events.find(event => event.event === 'window.activation.result' && event.notificationId === clickEvent.notificationId);
    const passed = activated === scenario.expectedActivation && nativeResult?.activated === scenario.expectedActivation
      && (scenario.expectedActivation || nativeResult?.reason === 'missing-binding')
      && (scenario.state !== 'maximize' || after.observations.some(observation => observation.at >= clickEvent.at && observation.foreground === a.hwnd && observation.maximized));
    const result = { scenario: scenario.name, expectedActivation: scenario.expectedActivation, unbound: unbind,
      clicked: mouse ?? { clicked: true, source: process.argv.includes('--protocol') ? 'registered-toast-uri' : 'native-callback', automatedMouseVerified: false }, before, after, target: a.hwnd, activated, passed };
    cases.push(result); console.log(JSON.stringify({ scenario: scenario.name, activated, passed, nativeResult, diagnostics: after.diagnostics }));
    mkdirSync('test-artifacts', { recursive: true });
    writeFileSync(join('test-artifacts', artifactFile), JSON.stringify({ root, a, b, cases }, null, 2));
  }
  mkdirSync('test-artifacts', { recursive: true });
  writeFileSync(join('test-artifacts', artifactFile), JSON.stringify({ root, a, b, cases }, null, 2));
  if (!process.argv.includes('--baseline') && cases.some(result => !result.passed)) process.exitCode = 1;
} catch (error) {
  mkdirSync('test-artifacts', { recursive: true });
  writeFileSync(join('test-artifacts', `toast-routing-failed-${Date.now()}.json`), JSON.stringify({ root, error: String(error), cases, lastSnapshot }, null, 2));
  console.error(error); process.exitCode = 1;
}
finally {
  // Close only the two isolated workspaces; the normal desktop instance is untouched.
  for (const child of children) child.kill();
  const pidFiles = ['A-ready.json', 'B-ready.json'];
  for (const file of pidFiles) if (existsSync(join(root, file))) { try { process.kill(read(file).extensionHostPid); } catch {} }
}

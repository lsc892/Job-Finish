import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const harness = resolve('.generated/profile-harness'); mkdirSync(harness, { recursive: true });
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(join(harness, 'package.json'), JSON.stringify({ name: 'job-finish-profile-test', publisher: 'job-finish-tests', version: '0.0.1', engines: manifest.engines,
  main: './extension.cjs', activationEvents: ['onStartupFinished'], contributes: manifest.contributes }));
await build({ entryPoints: ['tests/profile-host.ts'], outfile: join(harness, 'extension.cjs'), platform: 'node', target: 'node22', format: 'cjs', bundle: true,
  external: ['vscode', 'koffi', 'node-notifier', '@anthropic-ai/claude-agent-sdk'] });
const root = mkdtempSync(join(tmpdir(), 'job-finish-profile-')); const profile = join(root, 'profile');
const different = process.argv.includes('--different-projects');
const native = process.argv.includes('--native');
mkdirSync(join(profile, 'User'), { recursive: true }); mkdirSync(join(root, 'runtime-history'));
mkdirSync(join(root, 'extensions'));
// Development windows reuse one development path. Install this test-only junction in the isolated profile instead.
symlinkSync(harness, join(root, 'extensions', 'job-finish-tests.job-finish-profile-test-0.0.1'), 'junction');
writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({ 'jobFinish.codexExecutable': resolve('tests/fixtures/app-server.cjs'), 'jobFinish.toast': false, 'jobFinish.flash': native,
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'extensions.autoUpdate': false, 'window.title': 'JOB-FINISH SAME TITLE' }));
for (const role of ['A', 'B']) {
  const workspace = join(root, different ? `workspace-${role}` : 'workspace'); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(root, `${role}.code-workspace`), JSON.stringify({ folders: [{ path: workspace }] }));
}
const executable = process.env.JOB_FINISH_CODE_EXECUTABLE ?? join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
const env = { ...process.env, JOB_FINISH_PROFILE_ARTIFACTS: root, JOB_FINISH_FIXTURE_STORAGE: join(root, 'runtime-history') };
if (native) env.JOB_FINISH_PROFILE_NATIVE = '1'; else delete env.JOB_FINISH_PROFILE_NATIVE;
delete env.ELECTRON_RUN_AS_NODE; delete env.JOB_FINISH_TEST_SHARED_STORAGE;
const launch = role => spawn(executable, ['--new-window', '--user-data-dir', profile, '--extensions-dir', join(root, 'extensions'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', join(root, `${role}.code-workspace`)], { env, windowsHide: true, stdio: 'ignore' });
const until = async fn => { const end = Date.now() + 80_000; while (!fn()) { if (Date.now() > end) throw new Error(`Same-profile timeout; ${root}`); await new Promise(r => setTimeout(r, 100)); } };
const has = name => existsSync(join(root, name)); const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
console.log(`Same-profile artifacts: ${root}`);
const children = [launch('A')];
try {
  await until(() => has('A-ready.json') || has('A-result.json'));
  if (!has('A-ready.json')) throw new Error(JSON.stringify(read('A-result.json')));
  children.push(launch('B'));
  if (!native) {
  await until(() => has('A-kill-ready.json') || has('A-result.json') || has('B-result.json'));
  if (!has('A-kill-ready.json')) throw new Error(JSON.stringify(has('A-result.json') ? read('A-result.json') : read('B-result.json')));
  // The PID is emitted by our isolated harness only after its checkpoint is durable.
  const { extensionHostPid } = read('A-kill-ready.json').identity;
  if (!Number.isInteger(extensionHostPid) || extensionHostPid <= 0 || extensionHostPid === process.pid) throw new Error('Invalid owned Extension Host PID');
  process.kill(extensionHostPid, 'SIGKILL');
  }
  await until(() => has('A-result.json') && has('B-result.json'));
  const results = ['A', 'B'].map(role => read(`${role}-result.json`));
  mkdirSync('test-artifacts', { recursive: true });
  writeFileSync(`test-artifacts/same-profile${native ? '-native' : ''}${different ? '-different-projects' : ''}.json`, JSON.stringify({ root, sameProfile: true, differentProjects: different, results }, null, 2));
  console.log(JSON.stringify(results, null, 2)); if (results.some(r => !r.passed)) process.exitCode = 1;
} catch (error) { console.error(String(error)); process.exitCode = 1; }
finally { for (const child of children) child.kill(); }

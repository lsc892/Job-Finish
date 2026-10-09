import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
await build({ entryPoints: ['tests/extension-host.ts'], outfile: '.generated/extension-host.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['vscode', 'koffi'] });
const dual = process.argv.includes('--dual');
const root = mkdtempSync(join(tmpdir(), 'job-finish-host-'));
const profile = join(root, 'profile'); const workspace = join(root, 'workspace'); mkdirSync(join(profile, 'User'), { recursive: true }); mkdirSync(workspace);
writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({ 'jobFinish.codexExecutable': resolve('tests/fixtures/app-server.cjs'), 'jobFinish.toast': false, 'jobFinish.flash': dual, 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'extensions.autoUpdate': false }));
const executable = process.env.JOB_FINISH_CODE_EXECUTABLE ?? join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
const env = { ...process.env, JOB_FINISH_HOST_ARTIFACTS: root, JOB_FINISH_TEST_AGENT_ROOT: resolve('tests/fixtures') }; delete env.ELECTRON_RUN_AS_NODE;
if (dual) {
  env.JOB_FINISH_TEST_SHARED_STORAGE = join(root, 'shared-storage');
  const profileB = join(root, 'profile-B'); mkdirSync(join(profileB, 'User'), { recursive: true });
  copyFileSync(join(profile, 'User', 'settings.json'), join(profileB, 'User', 'settings.json'));
  for (const name of ['A', 'B']) writeFileSync(join(root, `${name}.code-workspace`), JSON.stringify({ folders: [{ path: workspace }] }));
  const launch = name => spawn(executable, ['--new-window', '--user-data-dir', name === 'A' ? profile : profileB, '--extensions-dir', join(root, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--extensionDevelopmentPath', process.cwd(), '--extensionTestsPath', resolve('.generated/extension-host.cjs'), join(root, `${name}.code-workspace`)], { env, windowsHide: true, stdio: 'ignore' });
  const children = [launch('A')];
  const until = async fn => { const end = Date.now() + 70_000; while (!fn()) { if (Date.now() > end) throw new Error(`Dual host timeout; ${root}`); await new Promise(r => setTimeout(r, 100)); } };
  try {
    await until(() => existsSync(join(root, 'A-ready.json')) || existsSync(join(root, 'A-result.json')));
    if (!existsSync(join(root, 'A-ready.json'))) throw new Error(readFileSync(join(root, 'A-result.json'), 'utf8'));
    children.push(launch('B'));
    await until(() => existsSync(join(root, 'A-result.json')) && existsSync(join(root, 'B-result.json')));
    const results = ['A', 'B'].map(role => JSON.parse(readFileSync(join(root, `${role}-result.json`), 'utf8')));
    mkdirSync('test-artifacts', { recursive: true }); writeFileSync('test-artifacts/dual-host.json', JSON.stringify({ root, results }, null, 2)); console.log(JSON.stringify(results, null, 2));
    if (results.some(r => !r.passed)) process.exitCode = 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { for (const child of children) child.kill(); }
  process.exit(process.exitCode ?? 0);
}
const child = spawn(executable, ['--user-data-dir', profile, '--extensions-dir', join(root, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--extensionDevelopmentPath', process.cwd(), '--extensionTestsPath', resolve('.generated/extension-host.cjs'), workspace], { env, windowsHide: true, stdio: 'ignore' });
const timeout = setTimeout(() => { child.kill(); console.error(`Extension host timed out; artifacts: ${root}`); process.exitCode = 1; }, 90_000);
await new Promise(resolve => { child.on('error', error => { console.error(error); process.exitCode = 1; resolve(); }); child.on('exit', resolve); }); clearTimeout(timeout);
const result = join(root, 'extension-host.json');
if (existsSync(result)) {
  const body = readFileSync(result, 'utf8'); mkdirSync('test-artifacts', { recursive: true }); writeFileSync('test-artifacts/extension-host.json', body); console.log(body); if (!JSON.parse(body).passed) process.exitCode = 1;
} else { console.error(`No Extension Host result; logs: ${root}`); process.exitCode = 1; }

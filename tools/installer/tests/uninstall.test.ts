import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { applyLegacyUninstall, planLegacyUninstall } from '../src/uninstall';

const command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\user\\.job-finish\\job-finish-notify.ps1" -Event stop';
const handler = { type: 'command', command };
const userHandler = { type: 'command', command: 'echo keep job-finish-notify in my notes' };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-uninstall-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const project = join(root, 'project with spaces');
  mkdirSync(home); mkdirSync(project);
  const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { root, home, project, write };
}

test('Legacy removal preserves mixed Claude/Codex hooks and user settings, with original backups', t => {
  const f = fixture(t);
  const claude = join(f.home, '.claude', 'settings.json');
  const local = join(f.project, '.claude', 'settings.local.json');
  const codex = join(f.home, '.codex', 'config.toml');
  const value = { permissions: { allow: ['Read'] }, hooks: {
    Stop: [{ matcher: '*', hooks: [handler, userHandler] }],
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [handler] }],
    Notification: [{ hooks: [userHandler] }] } };
  const text = JSON.stringify(value);
  f.write(claude, text); f.write(local, text);
  f.write(codex, TOML.stringify({ model: 'preserve-model', notify: ['python', 'my-notify.py'],
    hooks: { Stop: [{ hooks: [handler, userHandler], timeout: 30 }], SessionStart: [{ hooks: [userHandler] }] } }));
  const globalDir = join(f.home, '.job-finish'); const projectDir = join(f.project, '.claude', 'job-finish');
  f.write(join(globalDir, 'jf-focus-vscode.exe'), 'old executable');
  f.write(join(projectDir, 'job-finish-notify.ps1'), 'old notifier');
  const untouched = join(f.project, 'Program.cs'); f.write(untouched, 'user source');

  const plan = planLegacyUninstall(f);
  assert.equal(plan.configs.length, 3); assert.equal(plan.directories.length, 2);
  const backups = applyLegacyUninstall(plan);
  assert.equal(backups.length, 3);
  assert.equal(readFileSync(backups[0]!, 'utf8'), text);
  const expected = { permissions: value.permissions, hooks: {
    Stop: [{ matcher: '*', hooks: [userHandler] }], Notification: [{ hooks: [userHandler] }] } };
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')), expected);
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')), expected);
  const config = TOML.parse(readFileSync(codex, 'utf8'));
  assert.deepEqual(config.notify, ['python', 'my-notify.py']);
  assert.deepEqual(config.hooks, { Stop: [{ hooks: [userHandler], timeout: 30 }], SessionStart: [{ hooks: [userHandler] }] });
  assert.equal(config.model, 'preserve-model');
  assert.equal(existsSync(globalDir), false); assert.equal(existsSync(projectDir), false);
  assert.equal(readFileSync(untouched, 'utf8'), 'user source');
  assert.deepEqual(planLegacyUninstall(f), { configs: [], directories: [] });
});

test('Keep-files removes legacy notify and hooks but preserves installation files and unmarked directories', t => {
  const f = fixture(t); const custom = join(f.root, 'custom codex'); mkdirSync(custom);
  const codex = join(custom, 'config.toml');
  f.write(codex, TOML.stringify({ model: 'keep', notify: ['powershell', '-File', 'C:/user/.job-finish/job-finish-notify.ps1'],
    hooks: { Stop: [{ hooks: [handler] }] } }));
  const install = join(f.home, '.job-finish', 'jf-focus-vscode.exe'); f.write(install, 'keep');
  const unmarked = join(f.project, '.claude', 'job-finish', 'user.txt'); f.write(unmarked, 'keep');
  const plan = planLegacyUninstall({ ...f, codexHome: custom, keepFiles: true });
  assert.equal(plan.directories.length, 0); applyLegacyUninstall(plan);
  assert.deepEqual(TOML.parse(readFileSync(codex, 'utf8')), { model: 'keep' });
  assert.equal(existsSync(install), true);
  assert.equal(planLegacyUninstall(f).directories.length, 1);
  applyLegacyUninstall(planLegacyUninstall(f));
  assert.equal(readFileSync(unmarked, 'utf8'), 'keep');
});

test('Unrelated settings remain byte-for-byte intact with no backups', t => {
  const f = fixture(t); const config = join(f.home, '.codex', 'config.toml');
  const text = '# keep this comment\nmodel = "keep"\nnotify = ["echo", "job-finish-notify"]\n'; f.write(config, text);
  const plan = planLegacyUninstall(f);
  assert.deepEqual(applyLegacyUninstall(plan), []);
  assert.equal(readFileSync(config, 'utf8'), text);
  assert.deepEqual(readdirSync(dirname(config)), ['config.toml']);
});

test('Malformed settings block all changes before deleting a legacy installation', t => {
  const f = fixture(t); const claude = join(f.home, '.claude', 'settings.json');
  const text = JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }); f.write(claude, text);
  f.write(join(f.home, '.codex', 'config.toml'), 'bad = [');
  const install = join(f.home, '.job-finish', 'jf-focus-vscode.exe'); f.write(install, 'keep');
  assert.throws(() => planLegacyUninstall(f), /Cannot parse/);
  assert.equal(readFileSync(claude, 'utf8'), text);
  assert.equal(existsSync(install), true);
  assert.deepEqual(readdirSync(dirname(claude)), ['settings.json']);
});

test('Settings changed after preview are preserved and block directory deletion', t => {
  const f = fixture(t); const claude = join(f.home, '.claude', 'settings.json');
  f.write(claude, JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }));
  const install = join(f.home, '.job-finish', 'jf-focus-vscode.exe'); f.write(install, 'keep');
  const plan = planLegacyUninstall(f); f.write(claude, '{"new":"setting"}');
  assert.throws(() => applyLegacyUninstall(plan), /Settings changed/);
  assert.equal(readFileSync(claude, 'utf8'), '{"new":"setting"}'); assert.equal(existsSync(install), true);
});

test('Directory junctions cannot redirect recursive deletion into another project', t => {
  const f = fixture(t); const other = join(f.root, 'other project'); mkdirSync(other);
  const exe = join(other, 'jf-focus-vscode.exe'); f.write(exe, 'keep');
  symlinkSync(other, join(f.home, '.job-finish'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => planLegacyUninstall(f), /symlink or junction/);
  assert.equal(readFileSync(exe, 'utf8'), 'keep');
});

test('CLI dry-run leaves settings, backups and files untouched', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); const claude = join(f.home, '.claude', 'settings.json');
  const text = JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }); f.write(claude, text);
  const exe = join(f.home, '.job-finish', 'jf-focus-vscode.exe'); f.write(exe, 'keep');
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/cli.ts'),
    'uninstall', '--dry-run', '--keep-files', '--project', f.project], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), CODEX_HOME: join(f.home, '.codex') } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /훅 제거/);
  assert.equal(readFileSync(claude, 'utf8'), text); assert.equal(readFileSync(exe, 'utf8'), 'keep');
  assert.deepEqual(readdirSync(dirname(claude)), ['settings.json']);
});

test('Standalone CLI resolves the default project and relative paths from the caller directory', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); const settings = join(f.project, '.claude', 'settings.json');
  const text = JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }); f.write(settings, text);
  for (const args of [[], ['--project', 'project with spaces']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/cli.ts'),
      'uninstall', '--dry-run', '--keep-files', ...args], { cwd: resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true,
      env: { ...process.env, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), CODEX_HOME: join(f.home, '.codex'),
        INIT_CWD: args.length ? f.root : f.project } });
    assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes(settings), result.stdout);
    assert.equal(readFileSync(settings, 'utf8'), text);
  }
});

test('Legacy notifier settings are backed up outside the directory being removed', t => {
  const f = fixture(t); const dir = join(f.home, '.job-finish');
  const text = '{"flashTimeout":"infinite","sound":{"enabled":false}}';
  f.write(join(dir, 'job-finish.config.json'), text);
  const backups = applyLegacyUninstall(planLegacyUninstall(f));
  assert.equal(backups.length, 1);
  assert.equal(dirname(backups[0]!), f.home);
  assert.equal(readFileSync(backups[0]!, 'utf8'), text);
  assert.equal(existsSync(dir), false);
});

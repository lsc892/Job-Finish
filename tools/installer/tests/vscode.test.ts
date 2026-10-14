import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EXTENSION_ID, installOrUpdate } from '../src/flow';
import { readVSIX, resolveCode, VSCode } from '../src/vscode';

let codeAvailable = process.platform === 'win32';
if (codeAvailable) { try { resolveCode(); } catch { codeAvailable = false; } }

function vsix(root: string, version: string): string {
  const source = join(root, `source-${version}`); mkdirSync(join(source, 'extension'), { recursive: true });
  writeFileSync(join(source, 'extension', 'package.json'), JSON.stringify({ name: 'JobFinish', publisher: 'JobFinish',
    displayName: 'Job Finish Installer Test', version, engines: { vscode: '^1.99.0' }, main: './extension.cjs' }));
  writeFileSync(join(source, 'extension', 'extension.cjs'), 'exports.activate = () => {};');
  writeFileSync(join(source, 'extension.vsixmanifest'), `<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="JobFinish" Version="${version}" Publisher="JobFinish" /><DisplayName>Job Finish Installer Test</DisplayName><Description>Isolated test</Description></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation><Dependencies /><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets></PackageManifest>`);
  const path = join(root, `${version}.vsix`);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; Add-Type -AssemblyName System.IO.Compression; $zip = [IO.Compression.ZipFile]::Open($env:JOB_FINISH_TEST_VSIX, [IO.Compression.ZipArchiveMode]::Create); try { Get-ChildItem -LiteralPath $env:JOB_FINISH_TEST_SOURCE -Recurse -File | ForEach-Object { $name = $_.FullName.Substring($env:JOB_FINISH_TEST_SOURCE.Length + 1).Replace('\\', '/'); [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name) | Out-Null } } finally { $zip.Dispose() }"],
    { stdio: 'pipe', windowsHide: true, timeout: 10_000, env: { ...process.env, JOB_FINISH_TEST_SOURCE: source, JOB_FINISH_TEST_VSIX: path } });
  return path;
}

test('Real VS Code CLI installs, updates and preserves same/newer versions in an isolated profile', { skip: !codeAvailable, timeout: 45_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-install-code-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = vsix(root, '0.0.9'); const current = vsix(root, '0.1.0');
  assert.deepEqual(readVSIX(current), { id: EXTENSION_ID, version: '0.1.0', vscodeEngine: '^1.99.0' });
  const backend = new VSCode({ userDataDir: join(root, 'profile'), extensionsDir: join(root, 'extensions') });
  const services = { readPackage: readVSIX, installedVersion: (id: string) => backend.installedVersion(id),
    validateCompatibility: (extension: ReturnType<typeof readVSIX>) => backend.validateCompatibility(extension),
    inspectLegacy: () => ({ found: false, targets: [], remove: () => [] }), install: (path: string) => backend.install(path) };
  assert.equal(installOrUpdate(old, false, services, () => {}).action, 'install');
  assert.equal(installOrUpdate(current, false, services, () => {}).action, 'update');
  assert.equal(installOrUpdate(current, false, services, () => {}).action, 'unchanged');
  assert.equal(installOrUpdate(old, false, services, () => {}).action, 'unchanged');
  assert.equal(backend.installedVersion(EXTENSION_ID), '0.1.0');
});

test('Invalid VSIX is rejected without requiring any installation changes', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-install-invalid-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const invalid = join(root, 'invalid.vsix'); writeFileSync(invalid, 'not a ZIP');
  assert.throws(() => readVSIX(invalid));
  assert.throws(() => readVSIX(join(root, 'absent.vsix')), /VSIX 파일이 없습니다/);
});

test('CLI uninstall needs no VSIX, respects VS Code scope, and keep-files preserves only legacy files', { skip: !codeAvailable, timeout: 90_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'job-finish-remove-code-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
  const settings = join(home, '.claude', 'settings.json'); mkdirSync(dirname(settings));
  const before = JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command',
    command: 'powershell -File "C:/home/.job-finish/job-finish-notify.ps1"' }] }] } });
  writeFileSync(settings, before);
  const legacyFile = join(home, '.job-finish', 'jf-focus-vscode.exe'); mkdirSync(dirname(legacyFile)); writeFileSync(legacyFile, 'keep legacy');
  const scope = { userDataDir: join(root, 'user data'), extensionsDir: join(root, 'extension files') };
  // The extension-management CLI selects existing profiles; it does not create named profiles.
  const profileState = join(scope.userDataDir, 'User', 'globalStorage', 'storage.json'); mkdirSync(dirname(profileState), { recursive: true });
  writeFileSync(profileState, JSON.stringify({ userDataProfiles: [
    { name: 'Remove test profile', location: 'remove-test' }, { name: 'Preserve test profile', location: 'preserve-test' }
  ] }));
  const backend = new VSCode({ ...scope, profile: 'Remove test profile' });
  const preserved = new VSCode({ ...scope, profile: 'Preserve test profile' });
  const current = vsix(root, '0.1.0'); backend.install(current); preserved.install(current);
  const sharedArgs = ['--code', resolveCode().executable, '--profile', 'Remove test profile',
    '--user-data-dir', scope.userDataDir, '--extensions-dir', scope.extensionsDir, '--project', project, '--keep-files'];
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/cli.ts'), ...args],
    { cwd: resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 45_000,
      env: { ...process.env, USERPROFILE: home, CLAUDE_CONFIG_DIR: dirname(settings), CODEX_HOME: join(home, '.codex'), INIT_CWD: project } });
  const preview = run(['uninstall', '--dry-run', ...sharedArgs]);
  assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /현재 확장: 0\.1\.0/);
  assert.equal(backend.installedVersion(EXTENSION_ID), '0.1.0');
  assert.equal(readFileSync(settings, 'utf8'), before); assert.deepEqual(readdirSync(dirname(settings)), ['settings.json']);
  const removed = run(['uninstall', ...sharedArgs]);
  assert.equal(removed.status, 0, removed.stderr); assert.match(removed.stdout, /VS Code 확장 제거 완료/);
  assert.equal(backend.installedVersion(EXTENSION_ID), null);
  assert.equal(preserved.installedVersion(EXTENSION_ID), '0.1.0', 'The other named profile must retain the extension');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { permissions: { allow: ['Read'] } });
  assert.equal(readFileSync(legacyFile, 'utf8'), 'keep legacy');
  const backups = readdirSync(dirname(settings)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dirname(settings), backups[0]!), 'utf8'), before);
  const repeated = run(['uninstall', ...sharedArgs]);
  assert.equal(repeated.status, 0, repeated.stderr); assert.match(repeated.stdout, /설치되어 있지 않아/);
  assert.equal(readdirSync(dirname(settings)).filter(name => name.endsWith('.bak')).length, 1);
  backend.uninstall(EXTENSION_ID);
  assert.equal(existsSync(legacyFile), true);
});

test('CLI help identifies the npm command and distinguishes current and legacy removal', () => {
  const help = spawnSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/cli.ts'), '--help'],
    { cwd: resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /job-finish \[install\|update\|uninstall\|uninstall-legacy\]/);
  assert.match(help.stdout, /uninstall-legacy.*현재 확장 유지/);
  assert.match(help.stdout, /uninstall의 VS Code 확장 제거는 그대로 수행/);
});

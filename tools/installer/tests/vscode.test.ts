import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_ID, installOrUpdate } from '../src/flow';
import { readVSIX, resolveCode, VSCode } from '../src/vscode';

let codeAvailable = process.platform === 'win32';
if (codeAvailable) { try { resolveCode(); } catch { codeAvailable = false; } }

function vsix(root: string, version: string): string {
  const source = join(root, `source-${version}`); mkdirSync(join(source, 'extension'), { recursive: true });
  writeFileSync(join(source, 'extension', 'package.json'), JSON.stringify({ name: 'job-finish', publisher: 'lsc892',
    displayName: 'Job-Finish Installer Test', version, engines: { vscode: '^1.99.0' }, main: './extension.cjs' }));
  writeFileSync(join(source, 'extension', 'extension.cjs'), 'exports.activate = () => {};');
  writeFileSync(join(source, 'extension.vsixmanifest'), `<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="job-finish" Version="${version}" Publisher="lsc892" /><DisplayName>Job-Finish Installer Test</DisplayName><Description>Isolated test</Description></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation><Dependencies /><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets></PackageManifest>`);
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

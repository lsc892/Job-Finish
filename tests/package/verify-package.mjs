// VSIX를 격리 프로필에 설치해 번들 최신성·런타임 의존성·네이티브 도우미 포함을 검증한다.
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'job-finish-package-'));
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
const cli = process.env.JOB_FINISH_CODE_EXECUTABLE ?? join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
// Invoke VS Code's Node CLI directly, no cmd.exe interpolation of file paths.
const launcher = readFileSync(join(dirname(cli), 'bin/code.cmd'), 'utf8');
const relativeCli = launcher.match(/%~dp0\.\.\\([^"\r\n]+cli\.js)/)?.[1];
const cliScript = join(dirname(cli), relativeCli ?? 'resources/app/out/cli.js');
const { stdout } = await promisify(execFile)(cli, [cliScript, '--user-data-dir', join(root, 'profile'), '--extensions-dir', join(root, 'extensions'), '--install-extension', resolve('job-finish-win32-x64.vsix'), '--force'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_CLI: '1' }, windowsHide: true, timeout: 60_000 });
console.log(stdout.trim());
const installed = JSON.parse(readFileSync(join(root, 'extensions/extensions.json'), 'utf8')).find(entry => entry.identifier.id.toLowerCase() === extensionId);
if (!installed) throw new Error('Extension installation not registered');
const extension = join(root, 'extensions', installed.relativeLocation);
const packagedManifest = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8'));
if (packagedManifest.version !== manifest.version || packagedManifest.icon !== manifest.icon) throw new Error('VSIX manifest does not match the release');
if (!existsSync(join(extension, 'dist/extension.cjs'))) throw new Error('Packaged extension entry point missing');
for (const file of ['dist/extension.cjs', 'dist/native/JobFinish.Native.exe', manifest.icon, 'resources/icon/toast-default.png',
  'resources/icon/SnoreToast-NOTICE.md', 'resources/icon/SnoreToast-COPYING.LGPL-3', 'resources/icon/SnoreToast-COPYING.GPL-3']) {
  if (!readFileSync(join(extension, file)).equals(readFileSync(resolve(file)))) throw new Error(`VSIX contains a stale build: ${file}`);
}
const requireFromExtension = createRequire(join(extension, 'package.json'));
const koffi = requireFromExtension('koffi'); koffi.load('user32.dll');
if (packagedManifest.dependencies['@anthropic-ai/claude-agent-sdk']) throw new Error('Removed SDK remains in the package');
if (existsSync(join(extension, 'node_modules/@anthropic-ai/claude-agent-sdk'))) throw new Error('Removed SDK files remain in the VSIX');
for (const file of ['dist/native/JobFinish.Native.exe', 'docs/verification.md']) {
  if (!existsSync(join(extension, file))) throw new Error(`VSIX missing ${file}`);
}
const helper = join(extension, 'dist/native/JobFinish.Native.exe');
// Start the bundled self-contained helper without changing protocol registration.
let helperStarted = false;
try { await promisify(execFile)(helper, [], { windowsHide: true, timeout: 15_000 }); }
catch (error) { if (error.code !== 2) throw error; helperStarted = true; }
if (!helperStarted) throw new Error('Native helper did not return its no-arguments exit code');
const result = { installed: true, nativeLoaded: true, executionSdkRemoved: true, nativeToastHelperIncluded: true, extension, totalScope: 'isolated profile; user extensions unchanged' };
mkdirSync('test-artifacts', { recursive: true }); writeFileSync('test-artifacts/package.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
